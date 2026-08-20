# Deploying the program to devnet

You already have a Solana CLI wallet with SOL and a devnet USDC clone with a
funded treasury — this picks up from there. Everything below runs on your
machine; nothing here can be run from a sandbox, because the deploy authority
keypair and the resulting program keypair both need to live somewhere that
persists.

## 1. Toolchain

```bash
avm install 0.30.1 && avm use 0.30.1
anchor --version     # must print 0.30.1
solana --version     # 2.1.14 / platform-tools v1.43
```

If `anchor --version` doesn't print `0.30.1` even after `avm use`, the
`~/.avm/bin/anchor` symlink is pointing at `avm` itself:

```bash
ln -sf ~/.avm/bin/anchor-0.30.1 ~/.avm/bin/anchor
rehash   # zsh
```

## 2. Build

```bash
cd program
npm install
npm run sim          # economics sanity check, costs nothing
anchor build --no-idl
```

**Always `--no-idl`.** Plain `anchor build` tries to autogenerate an IDL
through your system Rust, which this toolchain's pinned dependency set makes
impossible — see `program/README.md` if you want the full story. The hand
generated IDL from `scripts/build-idl.mjs` replaces it.

### If `anchor build` fails with `feature 'edition2024' is required`

```
error: failed to download `block-buffer v0.12.1`
feature `edition2024` is required
The package requires the Cargo feature called `edition2024`, but that
feature is not stabilized in this version of Cargo (1.79.0 ...)
```

That `1.79.0` is platform-tools' bundled `rustc` (the compiler that actually
builds the BPF program), pinned by `solana --version` in step 1 — not your
system Rust. `edition2024` only stabilized in Rust 1.85 (Feb 2025). Nothing
in this repo asks for it; some transitive crate several layers down (here,
`block-buffer`, pulled in through `digest`/`sha2`) shipped a routine patch
release built against the newer edition after this program's dependency tree
was last resolved, and crates.io always serves the latest semver-compatible
version unless `Cargo.lock` pins it down.

The fix edits `Cargo.lock` only — pin the offending crate to the newest
version that predates its edition2024 jump. This needs a *newer* cargo than
platform-tools' to even parse-and-resolve, so use your system Rust for this
one command, then let `anchor build` go back to using platform-tools for the
actual build.

**Find the real source first — don't pin `block-buffer` directly.**
`Cargo.lock` can hold several major versions of the same crate at once (one
per incompatible dependent), so `cargo update -p block-buffer --precise
0.10.4` can silently patch an unrelated instance and leave the one that's
actually breaking the build untouched. Confirm the chain:

```bash
cd program
cargo tree -i block-buffer@0.12.1
```

In this program that resolves through `solana-program → blake3 → digest →
block-buffer`. `blake3` versions 1.8.3+ declare `edition = "2024"` in their
own `Cargo.toml` (independent of the block-buffer chain), and 1.8.6+
additionally bumped their `digest` dependency to a line that pulls in
`block-buffer 0.12`. `blake3` 1.8.0 and earlier are edition 2021 and depend
on `digest 0.10.1`, which only ever needs `block-buffer ^0.10` — pinning
`blake3` itself fixes both problems in one move:

```bash
rustc --version                        # confirm you have something newer than 1.79 as default
cargo update -p blake3 --precise 1.8.0
anchor build --no-idl
```

If system Rust is older than 1.79 too, or you don't have one on PATH:

```bash
rustup toolchain install stable
cd program
cargo +stable update -p blake3 --precise 1.8.0
anchor build --no-idl
```

If the same error resurfaces naming a *different* crate, use `cargo tree -i
<crate>@<version>` again to find what's actually pulling it in before pinning
anything — the crate named in the error is often several layers downstream
of the one you actually need to pin.

**Crates known to need this in this dependency tree, found so far:**

| Crate | Pin to | Why |
|---|---|---|
| `blake3` | `1.8.0` | 1.8.3+ is `edition = "2024"` itself; 1.8.6+ also pulls `digest 0.11` → `block-buffer 0.12` |
| `proc-macro-crate` | `3.3.0` | 3.5.0 (pulled in via `solana-program → borsh → borsh-derive`) depends on `toml_edit ^0.25.0`, which is `edition = "2024"` itself and floors `indexmap` at 2.13.0 — no indexmap pin escapes it while this stays at 3.5.0. `3.3.0` depends on `toml_edit ^0.22.24` instead (edition 2021), which only floors indexmap at 2.3.0 |
| `indexmap` | `2.11.0` | 2.12+ needs `hashbrown 0.16`; 2.14+ is `edition = "2024"` itself. 2.11.0's `hashbrown 0.15` is edition 2021 too, so no follow-on pin needed. Safe once `proc-macro-crate` above no longer forces the 2.13 floor |

```bash
cargo update -p blake3 --precise 1.8.0
cargo update -p proc-macro-crate --precise 3.3.0
cargo update -p indexmap --precise 2.11.0
anchor build --no-idl
```

Order matters a little here only in the sense that `indexmap` won't accept
2.11.0 until `proc-macro-crate` is pinned down first — if you run the
`indexmap` line first it'll fail with `required by package toml_edit ^0.25.0`
pointing at the same chain above; that's expected, not a new problem, just
re-run it after the `proc-macro-crate` line.

This is a wave, not two isolated incidents — a chunk of the crates.io
ecosystem raised their edition/MSRV around the same time, well after
platform-tools v1.43 was cut. Running both pins together up front, then
retrying, will likely surface fewer round trips than one at a time. Add rows
to this table as more turn up so a future redeploy doesn't repeat the hunt.

## 3. Generate a real program keypair and deploy

```bash
solana config set --url devnet
solana airdrop 2                       # repeat if it caps out; deploy needs several SOL
anchor keys sync                       # writes a new keypair, updates declare_id! in lib.rs
anchor build --no-idl                  # rebuild with the real address baked in
anchor deploy --provider.cluster devnet
```

`anchor deploy` prints the program ID. Copy it — you need it in four places
below. Deployment costs real devnet SOL (typically 2–4 SOL for a program this
size); keep airdropping if `solana airdrop` says the request was capped, or
space out a few requests.

PROGRAM_ID= FDBD4h5mZsYG8myfEE7NFFtmhuWqt5MJNHvgyfW57eYK
## 4. Regenerate the IDL with the real address

```bash
node scripts/build-idl.mjs --address <PROGRAM_ID_FROM_STEP_3>
```

This is the file everything downstream reads: `program/idl/acp.json`.

## 5. Point every app at the deployed program

**`backend/.env`**
```
ACP_PROGRAM_ID=<PROGRAM_ID_FROM_STEP_3>
```

**`program/.env`** (new — copy from `program/.env.example`)
```
ACP_PROGRAM_ID=<PROGRAM_ID_FROM_STEP_3>
SOLANA_RPC_URL=https://api.devnet.solana.com
USDC_MINT=<your existing devnet USDC mint>
TREASURY_ADDRESS=<your existing treasury wallet address>
EMPLOYER_KEYPAIR_PATH=~/.config/solana/id.json
```

Frontend and agent wiring for real transactions is a deliberate follow-up —
see the note at the end of `PATCHES-4.md`. Don't add
`NEXT_PUBLIC_ACP_PROGRAM_ID` yet; it isn't read anywhere until that lands, and
setting it early does nothing.

## 6. Prove it works before wiring anything else

```bash
cd program
npm run e2e
```

This runs the full happy path as real signed transactions — initializes the
oracle if it doesn't exist yet, registers the employer and agent profiles,
posts and funds a job, claims it, submits a plan, reports token usage, accepts
the plan, delivers, and accepts the deliverable — and prints your wallet's
USDC balance before and after. If those final numbers look right, the
mechanics are sound and wiring this into the browser next is low-risk. If
something's wrong, it's far cheaper to find out here than after wiring six
React components against a program that isn't behaving the way `math.rs`
assumes.

---

## Known friction points, in advance

- **Deploy needs several SOL**, more than a single `solana airdrop 2` covers.
  Devnet airdrops are rate-limited per address; if you hit the cap, wait a few
  minutes or try `solana airdrop 1` in smaller increments.
- **`anchor keys sync` changes your program ID.** If you ever redeploy from
  scratch (not upgrade — a fresh keypair), everything in step 6 needs
  updating again, and the e2e script's `initialize_oracle` guard will try to
  initialize a *second* oracle config for the new ID, which is correct
  behavior, not a bug.
- **This is a devnet program with a single admin key**, deployed by whichever
  wallet ran `anchor deploy`. That wallet can call `set_oracle_params`,
  `add_oracle_signer`, `remove_oracle_signer` — keep track of which one it
  was.