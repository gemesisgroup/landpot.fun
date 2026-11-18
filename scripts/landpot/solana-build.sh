#!/usr/bin/env bash
# Builds the Anchor program inside WSL/Linux and copies the artifacts back:
#   solana/landpot_escrow.so           the release program
#   solana/landpot_escrow_localnet.so  tests and dev:pot only (2 s review hold)
#   solana/landpot_escrow_devtest.so   the same fast build under its own
#                                      address, for devnet playtests only
#   src/api/pot/landpot_escrow.json    the IDL
# Run from Windows:  wsl -d Ubuntu -- bash scripts/landpot/solana-build.sh
# The program keypair (its address) lives in .data/solana/ (gitignored).
set -euo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$HOME/.avm/bin:$PATH"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$HOME/landpot-solana"
KEY="$REPO/.data/solana/landpot_escrow-keypair.json"
mkdir -p "$WORK/target/deploy" "$REPO/.data/solana"
if [ ! -f "$KEY" ]; then
  solana-keygen new --no-bip39-passphrase --silent --outfile "$KEY"
fi
rsync -a --delete --exclude target "$REPO/solana/" "$WORK/"
cp "$KEY" "$WORK/target/deploy/landpot_escrow-keypair.json"
cd "$WORK"
ID="$(solana-keygen pubkey target/deploy/landpot_escrow-keypair.json)"
sed -i "s/^declare_id!(\".*\");/declare_id!(\"$ID\");/" programs/landpot_escrow/src/lib.rs
sed -i "s/^landpot_escrow = \".*\"/landpot_escrow = \"$ID\"/" Anchor.toml
anchor build -- --features localnet
cp target/deploy/landpot_escrow.so "$REPO/solana/landpot_escrow_localnet.so"
anchor build
cp target/deploy/landpot_escrow.so "$REPO/solana/landpot_escrow.so"
cp target/idl/landpot_escrow.json "$REPO/src/api/pot/landpot_escrow.json"
cp target/types/landpot_escrow.ts "$REPO/src/api/pot/LandpotEscrowIdl.ts"
# Keep the committed sources in step with the program id.
cp programs/landpot_escrow/src/lib.rs "$REPO/solana/programs/landpot_escrow/src/lib.rs"
cp Anchor.toml "$REPO/solana/Anchor.toml"
[ -f Cargo.lock ] && cp Cargo.lock "$REPO/solana/Cargo.lock"

# The devnet playtest program: the fast review hold, never the release
# address, so a match can be played and paid out on devnet in minutes.
DEVKEY="$REPO/.data/solana/landpot_escrow_devtest-keypair.json"
if [ ! -f "$DEVKEY" ]; then
  solana-keygen new --no-bip39-passphrase --silent --outfile "$DEVKEY"
fi
DEVID="$(solana-keygen pubkey "$DEVKEY")"
cp "$DEVKEY" target/deploy/landpot_escrow-keypair.json
sed -i "s/^declare_id!(\".*\");/declare_id!(\"$DEVID\");/" programs/landpot_escrow/src/lib.rs
anchor build --no-idl -- --features localnet
cp target/deploy/landpot_escrow.so "$REPO/solana/landpot_escrow_devtest.so"
echo "$DEVID" > "$REPO/solana/landpot_escrow_devtest.id"
# Back to the release address for the next build.
cp "$KEY" target/deploy/landpot_escrow-keypair.json
sed -i "s/^declare_id!(\".*\");/declare_id!(\"$ID\");/" programs/landpot_escrow/src/lib.rs
echo "built $ID (devtest $DEVID)"
