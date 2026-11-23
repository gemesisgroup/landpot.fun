//! Landpot pot escrow (docs/LandpotPot.md): equal entries, a result signed by
//! the oracle, a review hold, then players claim their share.
//!
//! UNAUDITED. Devnet only until reviewed.
//!
//! A port of the Base contract (git history: contracts/LandpotEscrow.sol)
//! with the same rules. Solana differences:
//! - the oracle co-signs `propose` instead of a detached signature;
//! - the burn share is burned from the vault, not sent to a dead address;
//! - only the program's upgrade authority can `initialize` the config, so
//!   nobody can claim it between deploy and set-up;
//! - a settled round is closed once fully claimed and its rent goes back
//!   to the operator; the daily claim cap is one reused account per wallet;
//! - the mint must have no freeze authority and no extension beyond
//!   metadata (pump.fun mints are Token-2022 with metadata only).

use anchor_lang::prelude::*;
use anchor_spl::token::spl_token;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
};
use anchor_spl::token_interface::{
    self, BurnChecked, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

declare_id!("4cbs4ZSsC9E9S56QwoAxPKDPDjRbfWzoUso3R8NWq165");

pub const MAX_PLAYERS: usize = 16;
pub const MIN_PLAYERS: u8 = 8;
pub const DUEL_PLAYERS: u8 = 2;
const DAY: i64 = 86_400;
/// The shortest review hold. The `localnet` feature lets a local validator,
/// whose clock can't be moved, reach finalize. It is for tests, the local
/// dev stack and the devnet playtest program at its own address; it never
/// goes to the release address (scripts/landpot/solanaDeploy.ts checks).
#[cfg(not(feature = "localnet"))]
const MIN_REVIEW: i64 = DAY;
#[cfg(feature = "localnet")]
const MIN_REVIEW: i64 = 2;
const BPS: u128 = 10_000;

pub mod phase {
    pub const NONE: u8 = 0;
    pub const FUNDING: u8 = 1;
    pub const STARTED: u8 = 2;
    pub const PROPOSED: u8 = 3;
    pub const FINAL: u8 = 4;
    pub const REFUNDING: u8 = 5;
}

#[program]
pub mod landpot_escrow {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, args: InitArgs) -> Result<()> {
        require!(
            u32::from(args.burn_bps) + u32::from(args.treasury_bps) <= 4000
                && (MIN_REVIEW..=2 * DAY).contains(&args.review_delay)
                && args.max_bank > 0
                && args.daily_cap > 0,
            EscrowError::InvalidInput
        );
        let keys = [args.guardian, args.operator, args.oracle, args.treasury];
        require!(
            keys.iter().all(|k| *k != Pubkey::default()),
            EscrowError::InvalidInput
        );
        // The guardian freezes bad results; it must not be a hot server key.
        require!(
            args.guardian != args.operator && args.guardian != args.oracle,
            EscrowError::InvalidInput
        );
        check_mint(&ctx.accounts.mint.to_account_info())?;

        let config = &mut ctx.accounts.config;
        config.guardian = args.guardian;
        config.operator = args.operator;
        config.oracle = args.oracle;
        config.treasury = args.treasury;
        config.mint = ctx.accounts.mint.key();
        config.token_program = ctx.accounts.token_program.key();
        config.decimals = ctx.accounts.mint.decimals;
        config.burn_bps = args.burn_bps;
        config.treasury_bps = args.treasury_bps;
        config.review_delay = args.review_delay;
        config.max_bank = args.max_bank;
        config.daily_cap = args.daily_cap;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_paused(ctx: Context<GuardianOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(Paused { paused });
        Ok(())
    }

    pub fn open(
        ctx: Context<Open>,
        round_id: [u8; 32],
        stake: u64,
        min_players: u8,
        max_players: u8,
        funding_ends: i64,
        result_ends: i64,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        let now = Clock::get()?.unix_timestamp;
        require!(!config.paused, EscrowError::WrongPhase);
        let valid_size = (min_players == DUEL_PLAYERS && max_players == DUEL_PLAYERS)
            || (min_players >= MIN_PLAYERS
                && max_players >= min_players
                && usize::from(max_players) <= MAX_PLAYERS);
        require!(
            round_id != [0; 32]
                && stake > 0
                && valid_size
                && u128::from(stake) * u128::from(max_players) <= u128::from(config.max_bank)
                && funding_ends > now
                && funding_ends <= now + DAY
                && result_ends > funding_ends
                && result_ends <= funding_ends + 2 * DAY,
            EscrowError::InvalidInput
        );
        let round = &mut ctx.accounts.round;
        round.id = round_id;
        round.phase = phase::FUNDING;
        round.stake = stake;
        round.min_players = min_players;
        round.max_players = max_players;
        round.funding_ends = funding_ends;
        round.result_ends = result_ends;
        round.bump = ctx.bumps.round;
        round.vault_bump = ctx.bumps.vault;
        emit!(Opened {
            round_id,
            stake,
            funding_ends,
            result_ends
        });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let player = ctx.accounts.player.key();
        let round = &mut ctx.accounts.round;
        require!(
            !ctx.accounts.config.paused
                && round.phase == phase::FUNDING
                && now < round.funding_ends,
            EscrowError::WrongPhase
        );
        require!(
            round.index_of(&player).is_none() && round.count < round.max_players,
            EscrowError::LimitExceeded
        );
        let i = usize::from(round.count);
        round.players[i] = player;
        round.deposits[i] = round.stake;
        round.count += 1;
        round.balance = round
            .balance
            .checked_add(round.stake)
            .ok_or(EscrowError::InvalidInput)?;
        let stake = round.stake;

        let before = ctx.accounts.vault.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            stake,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        require!(
            ctx.accounts.vault.amount.checked_sub(before) == Some(stake),
            EscrowError::TransferFailed
        );
        emit!(Deposited {
            round_id: ctx.accounts.round.id,
            player
        });
        Ok(())
    }

    pub fn start(ctx: Context<OperatorRound>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let round = &mut ctx.accounts.round;
        require!(
            !ctx.accounts.config.paused
                && round.phase == phase::FUNDING
                && now < round.funding_ends
                && round.count >= round.min_players,
            EscrowError::WrongPhase
        );
        round.phase = phase::STARTED;
        emit!(Started { round_id: round.id });
        Ok(())
    }

    /// The oracle's split of the net pot, one amount per depositor in
    /// deposit order. It signs this transaction itself.
    pub fn propose(ctx: Context<Propose>, amounts: Vec<u64>, replay_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        let round = &mut ctx.accounts.round;
        require!(
            !config.paused && round.phase == phase::STARTED && now < round.result_ends,
            EscrowError::WrongPhase
        );
        require!(
            replay_hash != [0; 32] && amounts.len() == usize::from(round.count),
            EscrowError::InvalidInput
        );
        let total: u128 = amounts.iter().map(|a| u128::from(*a)).sum();
        let (burn, reserve) = fees(config, round.balance);
        require!(
            total == u128::from(round.balance) - u128::from(burn) - u128::from(reserve),
            EscrowError::InvalidInput
        );
        for (i, a) in amounts.iter().enumerate() {
            round.payouts[i] = *a;
        }
        round.replay_hash = replay_hash;
        round.release_at = now + config.review_delay;
        round.phase = phase::PROPOSED;
        emit!(Proposed {
            round_id: round.id,
            replay_hash,
            release_at: round.release_at
        });
        Ok(())
    }

    pub fn review(ctx: Context<Review>, freeze: bool) -> Result<()> {
        let round = &mut ctx.accounts.round;
        require!(round.phase == phase::PROPOSED, EscrowError::WrongPhase);
        round.frozen = freeze;
        emit!(Reviewed {
            round_id: round.id,
            frozen: freeze
        });
        Ok(())
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        let who = ctx.accounts.authority.key();
        let round = &mut ctx.accounts.round;
        let p = round.phase;
        // A frozen result is the guardian's to resolve, but not forever: one
        // more review period after release, anyone may refund the round.
        let timeout = (p == phase::FUNDING && now >= round.funding_ends)
            || (p == phase::STARTED && now >= round.result_ends)
            || (p == phase::PROPOSED && round.frozen && now >= round.release_at + config.review_delay);
        let guardian = who == config.guardian
            && (p == phase::FUNDING || p == phase::STARTED || (p == phase::PROPOSED && round.frozen));
        // The operator may close a lobby that will not fill. Only refunds.
        let lobby_closed = who == config.operator && p == phase::FUNDING;
        require!(timeout || guardian || lobby_closed, EscrowError::WrongPhase);
        round.phase = phase::REFUNDING;
        emit!(Refunding { round_id: round.id });
        Ok(())
    }

    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        let round = &mut ctx.accounts.round;
        require!(
            !config.paused && round.phase == phase::PROPOSED && !round.frozen && now >= round.release_at,
            EscrowError::WrongPhase
        );
        let (burn, reserve) = fees(config, round.balance);
        round.balance -= burn + reserve;
        round.phase = phase::FINAL;
        let id = round.id;
        let bump = [round.bump];
        let seeds: &[&[&[u8]]] = &[&[b"round", id.as_ref(), &bump]];
        let decimals = ctx.accounts.mint.decimals;
        if burn > 0 {
            token_interface::burn_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    BurnChecked {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.round.to_account_info(),
                    },
                    seeds,
                ),
                burn,
                decimals,
            )?;
        }
        if reserve > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.treasury_account.to_account_info(),
                        authority: ctx.accounts.round.to_account_info(),
                    },
                    seeds,
                ),
                reserve,
                decimals,
            )?;
        }
        emit!(Finalized { round_id: id });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let player = ctx.accounts.player.key();
        let daily_cap = ctx.accounts.config.daily_cap;
        let cap = &mut ctx.accounts.cap;
        let round = &mut ctx.accounts.round;
        let i = round.index_of(&player).ok_or(EscrowError::LimitExceeded)?;
        let amount = match round.phase {
            phase::REFUNDING => std::mem::take(&mut round.deposits[i]),
            phase::FINAL => {
                let day = now.div_euclid(DAY);
                if cap.day != day {
                    cap.day = day;
                    cap.paid = 0;
                }
                let award = round.payouts[i];
                let amount = award.min(daily_cap.saturating_sub(cap.paid));
                round.payouts[i] = award - amount;
                cap.paid += amount;
                amount
            }
            _ => return err!(EscrowError::WrongPhase),
        };
        require!(amount > 0, EscrowError::LimitExceeded);
        round.balance -= amount;
        let id = round.id;
        let bump = [round.bump];
        let seeds: &[&[&[u8]]] = &[&[b"round", id.as_ref(), &bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.round.to_account_info(),
                },
                seeds,
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(Claimed {
            round_id: id,
            player,
            amount
        });
        Ok(())
    }

    /// Closes a settled round once nothing is left to claim; the rent of the
    /// round and its vault goes back to the operator, who paid it.
    pub fn close_round(ctx: Context<CloseRound>) -> Result<()> {
        let round = &ctx.accounts.round;
        require!(
            (round.phase == phase::FINAL || round.phase == phase::REFUNDING)
                && round.balance == 0
                && ctx.accounts.vault.amount == 0,
            EscrowError::WrongPhase
        );
        let id = round.id;
        let bump = [round.bump];
        let seeds: &[&[&[u8]]] = &[&[b"round", id.as_ref(), &bump]];
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.operator.to_account_info(),
                authority: ctx.accounts.round.to_account_info(),
            },
            seeds,
        ))?;
        Ok(())
    }
}

fn fees(config: &Config, balance: u64) -> (u64, u64) {
    let b = u128::from(balance);
    (
        (b * u128::from(config.burn_bps) / BPS) as u64,
        (b * u128::from(config.treasury_bps) / BPS) as u64,
    )
}

/// The escrow must be able to move every token it holds: no freeze
/// authority, and no extension that could tax, hook, claw back or freeze a
/// transfer. Metadata is fine.
fn check_mint(mint: &AccountInfo) -> Result<()> {
    let data = mint.try_borrow_data()?;
    if *mint.owner == spl_token_2022::ID {
        let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&data)
            .map_err(|_| error!(EscrowError::BadMint))?;
        require!(state.base.freeze_authority.is_none(), EscrowError::BadMint);
        let types = state
            .get_extension_types()
            .map_err(|_| error!(EscrowError::BadMint))?;
        for t in types {
            require!(
                matches!(t, ExtensionType::MetadataPointer | ExtensionType::TokenMetadata),
                EscrowError::BadMint
            );
        }
    } else if *mint.owner == spl_token::ID {
        use anchor_lang::solana_program::program_pack::Pack;
        let state =
            spl_token::state::Mint::unpack(&data).map_err(|_| error!(EscrowError::BadMint))?;
        require!(state.freeze_authority.is_none(), EscrowError::BadMint);
    } else {
        return err!(EscrowError::BadMint);
    }
    Ok(())
}

// ── accounts ──

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub guardian: Pubkey,
    pub operator: Pubkey,
    pub oracle: Pubkey,
    pub treasury: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub burn_bps: u16,
    pub treasury_bps: u16,
    pub review_delay: i64,
    pub max_bank: u64,
    pub daily_cap: u64,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub id: [u8; 32],
    pub phase: u8,
    pub frozen: bool,
    pub min_players: u8,
    pub max_players: u8,
    pub count: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub stake: u64,
    pub balance: u64,
    pub funding_ends: i64,
    pub result_ends: i64,
    pub release_at: i64,
    pub replay_hash: [u8; 32],
    pub players: [Pubkey; MAX_PLAYERS],
    pub deposits: [u64; MAX_PLAYERS],
    pub payouts: [u64; MAX_PLAYERS],
}

impl Round {
    pub fn index_of(&self, player: &Pubkey) -> Option<usize> {
        self.players[..usize::from(self.count)]
            .iter()
            .position(|p| p == player)
    }
}

/// What a wallet has claimed today, for the daily cap. One per wallet,
/// reset when the day changes.
#[account]
#[derive(InitSpace)]
pub struct ClaimCap {
    pub day: i64,
    pub paid: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitArgs {
    pub guardian: Pubkey,
    pub operator: Pubkey,
    pub oracle: Pubkey,
    pub treasury: Pubkey,
    pub burn_bps: u16,
    pub treasury_bps: u16,
    pub review_delay: i64,
    pub max_bank: u64,
    pub daily_cap: u64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = *mint.to_account_info().owner @ EscrowError::BadMint)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ EscrowError::Unauthorized)]
    pub program: Program<'info, crate::program::LandpotEscrow>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ EscrowError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GuardianOnly<'info> {
    #[account(address = config.guardian @ EscrowError::Unauthorized)]
    pub guardian: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(round_id: [u8; 32])]
pub struct Open<'info> {
    #[account(mut, address = config.operator @ EscrowError::Unauthorized)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = operator,
        space = 8 + Round::INIT_SPACE,
        seeds = [b"round", round_id.as_ref()],
        bump
    )]
    pub round: Box<Account<'info, Round>>,
    #[account(address = config.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = operator,
        seeds = [b"vault", round.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = round,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub player: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(address = config.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = player,
        token::token_program = token_program
    )]
    pub from: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"vault", round.key().as_ref()], bump = round.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct OperatorRound<'info> {
    #[account(address = config.operator @ EscrowError::Unauthorized)]
    pub operator: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
}

#[derive(Accounts)]
pub struct Propose<'info> {
    #[account(address = config.oracle @ EscrowError::Unauthorized)]
    pub oracle: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
}

#[derive(Accounts)]
pub struct Review<'info> {
    #[account(address = config.guardian @ EscrowError::Unauthorized)]
    pub guardian: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, address = config.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [b"vault", round.key().as_ref()], bump = round.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = config.treasury,
        token::token_program = token_program
    )]
    pub treasury_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"round", round.id.as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, Round>>,
    #[account(address = config.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [b"vault", round.key().as_ref()], bump = round.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = player,
        token::token_program = token_program
    )]
    pub to: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = player,
        space = 8 + ClaimCap::INIT_SPACE,
        seeds = [b"cap", player.key().as_ref()],
        bump
    )]
    pub cap: Account<'info, ClaimCap>,
    #[account(address = config.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseRound<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = operator,
        seeds = [b"round", round.id.as_ref()],
        bump = round.bump
    )]
    pub round: Box<Account<'info, Round>>,
    #[account(mut, seeds = [b"vault", round.key().as_ref()], bump = round.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: receives the rent; must be the operator who paid it.
    #[account(mut, address = config.operator @ EscrowError::Unauthorized)]
    pub operator: UncheckedAccount<'info>,
    #[account(address = config.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
}

// ── events and errors ──

#[event]
pub struct Paused {
    pub paused: bool,
}
#[event]
pub struct Opened {
    pub round_id: [u8; 32],
    pub stake: u64,
    pub funding_ends: i64,
    pub result_ends: i64,
}
#[event]
pub struct Deposited {
    pub round_id: [u8; 32],
    pub player: Pubkey,
}
#[event]
pub struct Started {
    pub round_id: [u8; 32],
}
#[event]
pub struct Proposed {
    pub round_id: [u8; 32],
    pub replay_hash: [u8; 32],
    pub release_at: i64,
}
#[event]
pub struct Reviewed {
    pub round_id: [u8; 32],
    pub frozen: bool,
}
#[event]
pub struct Refunding {
    pub round_id: [u8; 32],
}
#[event]
pub struct Finalized {
    pub round_id: [u8; 32],
}
#[event]
pub struct Claimed {
    pub round_id: [u8; 32],
    pub player: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg("not allowed for this signer")]
    Unauthorized,
    #[msg("invalid input")]
    InvalidInput,
    #[msg("not in this phase")]
    WrongPhase,
    #[msg("limit reached or nothing to claim")]
    LimitExceeded,
    #[msg("the vault did not receive the full amount")]
    TransferFailed,
    #[msg("mint not supported: freeze authority or a disallowed extension")]
    BadMint,
}
