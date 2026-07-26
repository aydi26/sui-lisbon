// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3
// @status     DONE
// @spec       aphotic.md#7.6 <- "Output: a distribution over wait time, not a point estimate."
// @spec       aphotic.md#5 (repo shape) <- `sim/` — order-flow simulation, latency calibration
// @rules      G3 G6
// @depends    sim::latency · sim::flow · clearing::json
// @facts      Writes two JSON files the TypeScript keeper reads:
// @facts        --out        latency.json   schema aphotic.latency.v1
// @facts        --flow-out   flow.json      schema aphotic.orderflow.v1
// @facts      Both are DETERMINISTIC given `--seed`; re-running overwrites with identical bytes.
// @facts      ⚠ latency.json carries `"calibrated_against_hashi_sim": false` and always will,
// @facts        until Hashi's `crates/hashi/src/utxo_pool/sim.rs` is actually available to link
// @facts        against. It is not in this repository. See sim/src/latency.rs.
// @implements fn main() — the CLI
// @forbidden  a network call. This binary is offline; it reads nothing but its own flags.
// @verify     cd clearing-rs; cargo run -p sim -- --help
// @verify     cd clearing-rs; cargo run -p sim -- --out latency.json --flow-out flow.json
// └── END CONTRACT ───────────────────────────────────────────────────────────

mod flow;
mod latency;

use std::process::ExitCode;

use clearing::json;

const USAGE: &str = "\
sim — Aphotic exit-latency and order-flow simulator

USAGE
    sim [OPTIONS]

OPTIONS
    --out <PATH>            write the latency distribution here     [default: stdout]
    --flow-out <PATH>       also write an order-flow summary here
    --seed <U64>            seed both simulations                   [default: 42405 / 2827]
    --samples <N>           latency Monte Carlo draws               [default: 20000]
    --amount-sats <N>       the withdrawal being timed              [default: 100000000]
    --queue-depth-sats <N>  sats already ahead in the queue         [default: 0]
    --tokens <N>            limiter tokens available at t=0         [default: cap]
    --confirmations <N>     Bitcoin confirmations required          [default: 6]
    --batches <N>           order-flow batches to simulate          [default: 2000]
    -h, --help              this text

NOTE
    The latency model is STANDALONE. Hashi's crates/hashi/src/utxo_pool/sim.rs is not present
    in this repository, so the UTXO-fragmentation leg is parameterised rather than calibrated.
    The limiter leg is the vendored Hashi algorithm with the live scalars. Every emitted file
    says so in its `calibrated_against_hashi_sim` field. Size the carry off p95/p99, not the
    mean — aphotic.md §7.6.
";

fn arg_u64(args: &[String], i: usize, name: &str) -> Result<u64, String> {
    args.get(i + 1)
        .ok_or_else(|| format!("{name} needs a value"))?
        .parse::<u64>()
        .map_err(|_| format!("{name}: not a u64"))
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut lat = latency::ModelConfig::default();
    let mut fl = flow::FlowConfig::default();
    let mut out: Option<String> = None;
    let mut flow_out: Option<String> = None;

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => {
                print!("{USAGE}");
                return Ok(());
            }
            "--out" => {
                out = Some(args.get(i + 1).ok_or("--out needs a path")?.clone());
                i += 2;
            }
            "--flow-out" => {
                flow_out = Some(args.get(i + 1).ok_or("--flow-out needs a path")?.clone());
                i += 2;
            }
            "--seed" => {
                let s = arg_u64(&args, i, "--seed")?;
                lat.seed = s;
                fl.seed = s;
                i += 2;
            }
            "--samples" => {
                lat.samples = arg_u64(&args, i, "--samples")? as usize;
                i += 2;
            }
            "--amount-sats" => {
                lat.amount_sats = arg_u64(&args, i, "--amount-sats")?;
                i += 2;
            }
            "--queue-depth-sats" => {
                lat.queue_depth_sats = arg_u64(&args, i, "--queue-depth-sats")?;
                i += 2;
            }
            "--tokens" => {
                lat.tokens_at_start = arg_u64(&args, i, "--tokens")?;
                i += 2;
            }
            "--confirmations" => {
                lat.confirmations = arg_u64(&args, i, "--confirmations")? as u32;
                i += 2;
            }
            "--batches" => {
                fl.batches = arg_u64(&args, i, "--batches")? as usize;
                i += 2;
            }
            other => return Err(format!("unknown option {other}\n\n{USAGE}")),
        }
    }

    let dist = latency::simulate(&lat);
    let text = json::write(&dist.to_json(&lat));
    match &out {
        Some(p) => {
            std::fs::write(p, &text).map_err(|e| format!("writing {p}: {e}"))?;
            eprintln!(
                "latency  -> {p}   p50 {}s  p95 {}s  p99 {}s  max {}s  (samples {})",
                dist.p50_s, dist.p95_s, dist.p99_s, dist.max_s, dist.samples
            );
        }
        None => print!("{text}"),
    }

    if let Some(p) = &flow_out {
        let summary = flow::simulate_flow(&fl);
        std::fs::write(p, json::write(&summary.to_json(&fl)))
            .map_err(|e| format!("writing {p}: {e}"))?;
        eprintln!(
            "flow     -> {p}   {} batches, {} cleared, median fill {} bps",
            summary.batches, summary.cleared, summary.fill_ratio_p50_bps
        );
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("sim: {e}");
            ExitCode::FAILURE
        }
    }
}
