# Terms of Service

_Last updated: 18 November 2026 · Draft pending legal review_

These terms are an agreement between you and **[OPERATOR LEGAL NAME]** ("Landpot", "we", "us"), the operator of landpot.fun and the Landpot game (the "Service"). By playing or connecting a wallet, you accept them. If you do not accept them, do not use the Service.

## 1. What Landpot is

Landpot is a real-time territory game played in the browser. Matches are free to play during the alpha. Paid matches, where players put an entry into a shared pot that the winners split, are planned and are covered by section 6. Until they launch, nothing on the Service costs money.

Landpot is built on OpenFrontIO and is free software under the GNU Affero General Public License v3.0. The source code is linked in the footer. These terms do not limit any right the licence gives you over the code. They govern your use of the Service we run.

## 2. Who can play

You must be at least 13 years old to play free matches, and at least 18 (or the age of majority where you live, if higher) to enter a paid match. You may not use the Service where doing so is against the law, and you are responsible for knowing whether it is allowed where you are. We may block access from places where we believe the Service, or a part of it, is not permitted.

## 3. Your session and your wallet

You can play as a guest: the Service gives your browser an anonymous identity kept in a cookie. You can also sign in by signing a message with an Ethereum-compatible wallet. Signing in never moves funds and costs no gas.

Your wallet is yours alone. We never hold your private keys or seed phrase and will never ask for them. You are responsible for the security of your wallet and device, and for every action signed with them.

## 4. Fair play

You agree not to:

- cheat, including with bots, scripts, modified clients, or exploits of bugs;
- coordinate with other players to fix a match ("teaming" in free-for-all modes, collusion in paid matches, or playing several seats yourself);
- attack, overload, or interfere with the Service or other players;
- use names or messages that are hateful, harassing, sexual, or that impersonate someone;
- use the Service to launder money or for any other unlawful purpose.

Every match is recorded as the list of player inputs, and the game is deterministic: replaying the inputs reproduces the match exactly. We use these records to review disputes and to detect cheating. We may remove names, end sessions, void matches, and suspend or ban players who break these rules.

## 5. Your content

Your username and in-game actions are shown to other players, and match records, with player identifiers removed, are published as replays. You give us a worldwide, royalty-free licence to store, display, and replay them as part of the Service.

## 6. Paid matches

This section applies once paid matches launch. We will announce the launch on the Service.

- **Entry and pot.** Every player in a paid match pays the same entry. Each paid lobby shows the entry, the token it is paid in, and the number of seats before you join. Your entry goes from your wallet to an escrow smart contract, not to us, and only the wallet that paid it can take a seat.
- **Start.** A paid match starts when every seat is paid and every player who paid is in the lobby, or a minute after the last entry once at least the minimum number of players have paid and are in the lobby, or shortly before entries close if at least the minimum have paid and at least two of them are in the lobby. A player who paid but is not in the lobby when the match starts is left out of it and gets their entry back at settlement, less their equal share of the fees below. If too few have paid or are present when entries close, the lobby is cancelled and every entry is refunded in full.
- **Fees.** At settlement 2% of the pot is burned and 3% goes to the treasury. You also pay the network's transaction fees for the transactions you send.
- **How the pot is split.** The rest of the pot is shared among the players in proportion to the land each holds when the match ends. A player with no land at the end gets nothing. Rounding is settled by a fixed rule published in the source code, so the amounts always add up to the pot.
- **Result.** Our server replays the recorded match to measure everyone's land and submits the split to the contract with a signature. The match record is public, so anyone can check the result.
- **Review and claim.** A submitted result is held for a review period of 24 to 48 hours, set in the contract. During it we can freeze a result we believe is wrong. After it, the result is final and each player claims their share from the contract. Claims are limited per wallet per day; a larger share is claimed over several days.
- **Refunds.** If a paid match does not start in time, gets no result in time, is cancelled, or has a frozen result that is not resolved, every entry is returned in full through the contract and each player claims it back. A match in which we find cheating or collusion may be cancelled this way.
- **Skill.** Paid matches are contests of skill. There is no random prize draw, and we do not play against you.
- **No investment.** An entry is the price of taking part in a match. It is not an investment, a deposit, or a security, and the Service does not give financial advice.
- **Blockchain risk.** Transactions on a blockchain cannot be reversed by us. Smart contracts, networks, and wallets can fail or be attacked. Token values change. You accept these risks.
- **Taxes.** You are responsible for any tax on your winnings.

## 7. Availability and changes

The Service is in alpha. It can change, break, lose data, or be unavailable, and we may change or end any part of it. Free-match records and accounts may be reset during the alpha. Before paid matches launch we will not reset anything that affects money you have put in.

## 8. Disclaimers

The Service is provided "as is" and "as available", without warranties of any kind, to the extent the law allows.

## 9. Limitation of liability

To the extent the law allows, we are not liable for indirect, incidental, or consequential losses, or for lost profits, data, or tokens arising from your use of the Service. Our total liability for any claim is limited to the greater of the entries you paid in the 30 days before the claim, or 100 US dollars. Nothing in these terms limits liability that cannot be limited by law.

## 10. Ending your use

You can stop using the Service at any time. We may suspend or end your access if you break these terms or if the law requires it. Entries already in escrow are then settled or returned under section 6.

## 11. Changes to these terms

We may update these terms. We will change the date at the top and, for changes that matter, announce them on the Service before they take effect. Continuing to play after that means you accept the new terms.

## 12. Law and disputes

These terms are governed by the laws of **[JURISDICTION]**, and disputes go to its courts, unless the law where you live gives you the right to bring them elsewhere.

## 13. Contact

**[CONTACT EMAIL]**
