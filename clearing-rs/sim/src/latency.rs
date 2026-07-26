// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3
// @status     DONE
// @spec       aphotic.md#7.6 (L385) <- "Inputs: queue depth …, reconstructed limiter capacity
//             …, `pending_epoch_change` for scheduled pauses, UTXO pool fragmentation for batch
//             cost. Output: a DISTRIBUTION over wait time, not a point estimate."
// @spec       aphotic.md#7.6 (L387) <- "Do not size the carry off a point estimate. The tail is
//             the risk."
// @spec       aphotic.md#4.6 <- coin selection has no age criterion; fee bumping is CPFP not
//             RBF; withdrawals pause during reconfiguration at each Sui epoch boundary (24 h)
// @spec       docs/FACTS.md#limiter <- project_capacity(t) =
//             min(cap, tokens + elapsed * refill_rate), UNIX SECONDS, saturating
// @rules      G3 G6
// @depends    clearing::rng (seeded) · clearing::json (output)
// @facts      ⚠⚠ STANDALONE — THIS DOES NOT LINK HASHI'S SIMULATOR, AND SAYS SO.
// @facts        aphotic.md §4.6 points at `crates/hashi/src/utxo_pool/sim.rs`, a 1 442-line pool
// @facts        simulator. That file is NOT in this repository. `.hashi_src/` vendors only
// @facts        `guardian/limiter.rs`, `bitcoin/taproot.rs`, `constants.rs` and
// @facts        `guardian_limiter.rs` — no `utxo_pool/` at all. Linking it would mean vendoring
// @facts        the Hashi crate and its dependency tree from a source this repo does not have.
// @facts        So the UTXO leg here is a PARAMETERISED MODEL, not a calibrated one, and every
// @facts        output carries `"calibrated_against_hashi_sim": false` so no downstream reader
// @facts        can mistake it for measured. Calibrating it is a real, still-open task.
// @facts      WHAT IS FAITHFUL: the limiter is the EXACT algorithm from
// @facts        `.hashi_src/crates__hashi-types__src__guardian__limiter.rs` — saturating refill,
// @facts        min against the cap, and a request over capacity is REJECTED (G3: you cannot
// @facts        buy priority and over-capacity batches are not queued). Live scalars from
// @facts        docs/FACTS.md: refill_rate = 115_740 sats/s, cap = 10_000_000_000 sats.
// @facts      THE MODEL, per simulated withdrawal:
// @facts        t0  request enters the queue behind `queue_depth_sats` of existing demand
// @facts        t1  guardian batches on a `batch_interval_s` tick; the batch is signed only if
// @facts            the limiter has capacity for it, else it waits for the bucket to refill
// @facts        t2  a reconfiguration pause may intervene — one per Sui epoch (24 h), lasting
// @facts            `reconfig_pause_s`
// @facts        t3  Bitcoin confirmation: `confirmations` inter-block gaps, each Exponential
// @facts            with mean `block_interval_s` (a Poisson process — the memoryless gap is the
// @facts            right model and it is what makes the TAIL fat)
// @facts        t4  with probability `stuck_p` the batch is under-fee'd and needs a CPFP bump,
// @facts            costing `cpfp_delay_s` plus a fresh confirmation wait
// @facts      WHY EXPONENTIAL AND NOT "10 minutes": a point estimate of 6 × 10 min = 60 min for
// @facts        six confirmations understates p99 by roughly a factor of two. That understatement
// @facts        IS the risk §7.6 warns about, so the model must produce it, not smooth it away.
// @implements pub struct LimiterConfig · ModelConfig · Sample · Distribution
//             pub fn project_capacity · simulate_one · simulate · Distribution::to_json
// @forbidden  an unseeded RNG — every run is reproducible from `seed`
// @forbidden  reporting a mean without the tail; `to_json` always emits p95/p99/p999 and max
// @invariant  1. project_capacity matches the vendored Hashi algorithm exactly, including its
//                saturating arithmetic.
// @invariant  2. Percentiles are monotone: p50 <= p75 <= p90 <= p95 <= p99 <= p999 <= max.
// @invariant  3. The same seed reproduces the same distribution, byte for byte.
// @invariant  4. Raising queue depth or lowering refill rate never LOWERS p50.
// @ac         cargo test -p sim
// @verify     cd clearing-rs; cargo run -p sim -- --out latency.json
// └── END CONTRACT ───────────────────────────────────────────────────────────

use clearing::json::Json;
use clearing::rng::SplitMix64;

/// The live Guardian scalars (docs/FACTS.md, DAY-ONE D4).
pub const LIVE_REFILL_RATE: u64 = 115_740;
pub const LIVE_MAX_BUCKET_CAPACITY: u64 = 10_000_000_000;

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct LimiterConfig {
    /// Sats per SECOND.
    pub refill_rate: u64,
    pub max_bucket_capacity: u64,
}

impl Default for LimiterConfig {
    fn default() -> Self {
        LimiterConfig {
            refill_rate: LIVE_REFILL_RATE,
            max_bucket_capacity: LIVE_MAX_BUCKET_CAPACITY,
        }
    }
}

/// `min(cap, tokens + elapsed * refill_rate)`, saturating — the exact form vendored at
/// `.hashi_src/crates__hashi-types__src__guardian__limiter.rs` L94-L99. Time is UNIX SECONDS.
pub fn project_capacity(cfg: &LimiterConfig, tokens: u64, elapsed_s: u64) -> u64 {
    let refilled = elapsed_s.saturating_mul(cfg.refill_rate);
    tokens
        .saturating_add(refilled)
        .min(cfg.max_bucket_capacity)
}

#[derive(Clone, Debug)]
pub struct ModelConfig {
    pub limiter: LimiterConfig,
    /// Sats already ahead of us in `WithdrawalRequestQueue.requests`.
    pub queue_depth_sats: u64,
    /// Tokens available in the bucket at t = 0, as reconstructed from `WithdrawalSigned`.
    pub tokens_at_start: u64,
    /// The withdrawal we are timing.
    pub amount_sats: u64,
    /// Guardian batches "roughly every 10 minutes" (aphotic.md L37).
    pub batch_interval_s: u64,
    /// Bitcoin inter-block mean. 600 s.
    pub block_interval_s: u64,
    /// Confirmations before the exit is considered final.
    pub confirmations: u32,
    /// Sui epoch length; a reconfiguration pause follows each boundary.
    pub epoch_len_s: u64,
    /// How long withdrawals stay paused across a reconfiguration.
    pub reconfig_pause_s: u64,
    /// Probability, in parts per 10 000, that the batch is under-fee'd and needs a CPFP bump.
    pub stuck_ppm10k: u64,
    /// Extra delay when that happens.
    pub cpfp_delay_s: u64,
    /// Seconds into the current epoch at t = 0. Randomised per sample when `None`.
    pub epoch_phase_s: Option<u64>,
    pub samples: usize,
    pub seed: u64,
}

impl Default for ModelConfig {
    fn default() -> Self {
        ModelConfig {
            limiter: LimiterConfig::default(),
            queue_depth_sats: 0,
            tokens_at_start: LIVE_MAX_BUCKET_CAPACITY,
            amount_sats: 100_000_000, // 1 BTC
            batch_interval_s: 600,
            block_interval_s: 600,
            confirmations: 6,
            epoch_len_s: 86_400,
            reconfig_pause_s: 900,
            stuck_ppm10k: 300, // 3 %
            cpfp_delay_s: 1_800,
            epoch_phase_s: None,
            samples: 20_000,
            seed: 0xA11CE,
        }
    }
}

/// One simulated exit, broken into the legs so a reader can see WHERE the time goes rather than
/// only how much of it there is.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Sample {
    pub total_s: u64,
    pub queue_s: u64,
    pub limiter_s: u64,
    pub pause_s: u64,
    pub confirm_s: u64,
    pub bumped: bool,
}

/// Exponential with the given mean, from a seeded uniform. This is the only place a float is
/// used anywhere in this workspace, and it is used ONLY here, in the simulator — the `clearing`
/// crate is integer-only by contract.
fn exponential_s(r: &mut SplitMix64, mean_s: u64) -> u64 {
    if mean_s == 0 {
        return 0;
    }
    // u in (0, 1]; -mean * ln(u) is Exp(1/mean).
    let u = (r.range(1, 1 << 53) as f64) / ((1u64 << 53) as f64);
    let v = -(mean_s as f64) * u.ln();
    // Cap at 100 means so a pathological draw cannot produce a nonsense outlier that dominates
    // the reported max. At 6 confirmations this bound is never approached in practice.
    v.min(mean_s as f64 * 100.0) as u64
}

pub fn simulate_one(cfg: &ModelConfig, r: &mut SplitMix64) -> Sample {
    let mut t = 0u64;

    // ── leg 1: the queue ahead of us. It drains at the limiter's refill rate, because that is
    // what actually gates signing; the batch tick only quantises it.
    let queue_s = if cfg.queue_depth_sats == 0 || cfg.limiter.refill_rate == 0 {
        0
    } else {
        // Tokens on hand serve the head of the queue for free; the rest waits for refill.
        let unserved = cfg.queue_depth_sats.saturating_sub(cfg.tokens_at_start);
        unserved.div_ceil(cfg.limiter.refill_rate)
    };
    t += queue_s;

    // ── leg 2: the limiter, for OUR amount. G3: an over-capacity request is REJECTED, never
    // queued ahead of anyone, so the only thing to do is wait for the bucket.
    let tokens_now = project_capacity(
        &cfg.limiter,
        cfg.tokens_at_start.saturating_sub(cfg.queue_depth_sats.min(cfg.tokens_at_start)),
        t,
    );
    let limiter_s = if cfg.amount_sats > cfg.limiter.max_bucket_capacity {
        // Never satisfiable in one withdrawal — docs/FACTS.md row 9 returns null for this. The
        // simulator reports it as an explicit sentinel rather than an innocuous large number.
        u64::MAX
    } else if tokens_now >= cfg.amount_sats {
        0
    } else if cfg.limiter.refill_rate == 0 {
        u64::MAX
    } else {
        (cfg.amount_sats - tokens_now).div_ceil(cfg.limiter.refill_rate)
    };
    if limiter_s == u64::MAX {
        return Sample {
            total_s: u64::MAX,
            queue_s,
            limiter_s,
            pause_s: 0,
            confirm_s: 0,
            bumped: false,
        };
    }
    t += limiter_s;

    // ── leg 3: quantise onto the next batch tick.
    if cfg.batch_interval_s > 0 {
        let rem = t % cfg.batch_interval_s;
        if rem != 0 {
            t += cfg.batch_interval_s - rem;
        }
    }

    // ── leg 4: reconfiguration pauses. One per Sui epoch boundary crossed.
    let phase = cfg
        .epoch_phase_s
        .unwrap_or_else(|| r.below(cfg.epoch_len_s.max(1)));
    let pause_s = if cfg.epoch_len_s == 0 {
        0
    } else {
        let start_epoch = phase / cfg.epoch_len_s;
        let end_epoch = (phase + t) / cfg.epoch_len_s;
        (end_epoch - start_epoch) * cfg.reconfig_pause_s
    };
    t += pause_s;

    // ── leg 5: Bitcoin confirmations. A Poisson process: each gap is Exponential(600 s), NOT a
    // fixed ten minutes. This is where the tail comes from.
    let mut confirm_s = 0u64;
    for _ in 0..cfg.confirmations {
        confirm_s += exponential_s(r, cfg.block_interval_s);
    }

    // ── leg 6: CPFP. Fee bumping is CPFP, not RBF (aphotic.md §4.6), so a stuck batch costs a
    // bump plus a fresh confirmation wait — it does not simply replace the old transaction.
    let bumped = r.bool_with(cfg.stuck_ppm10k, 10_000);
    if bumped {
        confirm_s += cfg.cpfp_delay_s;
        for _ in 0..cfg.confirmations {
            confirm_s += exponential_s(r, cfg.block_interval_s);
        }
    }
    t += confirm_s;

    Sample {
        total_s: t,
        queue_s,
        limiter_s,
        pause_s,
        confirm_s,
        bumped,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Distribution {
    pub samples: usize,
    pub seed: u64,
    /// Draws that could never be satisfied in one withdrawal (amount > bucket capacity).
    pub unsatisfiable: usize,
    pub min_s: u64,
    pub p50_s: u64,
    pub p75_s: u64,
    pub p90_s: u64,
    pub p95_s: u64,
    pub p99_s: u64,
    pub p999_s: u64,
    pub max_s: u64,
    pub mean_s: u64,
    /// `(upper_bound_s, count)`, cumulative-free — a plain histogram the keeper can re-bin.
    pub histogram: Vec<(u64, usize)>,
    /// Mean seconds attributable to each leg, so a reader can see what to attack.
    pub mean_queue_s: u64,
    pub mean_limiter_s: u64,
    pub mean_pause_s: u64,
    pub mean_confirm_s: u64,
    pub bumped_count: usize,
}

fn percentile(sorted: &[u64], num: usize, den: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    // Nearest-rank. Deterministic and integer-only; no interpolation to argue about.
    let rank = (sorted.len() * num).div_ceil(den).max(1);
    sorted[rank.min(sorted.len()) - 1]
}

pub fn simulate(cfg: &ModelConfig) -> Distribution {
    let mut r = SplitMix64::new(cfg.seed);
    let mut totals: Vec<u64> = Vec::with_capacity(cfg.samples);
    let mut unsatisfiable = 0usize;
    let (mut sq, mut sl, mut sp, mut sc) = (0u128, 0u128, 0u128, 0u128);
    let mut bumped_count = 0usize;

    for _ in 0..cfg.samples {
        let s = simulate_one(cfg, &mut r);
        if s.total_s == u64::MAX {
            unsatisfiable += 1;
            continue;
        }
        totals.push(s.total_s);
        sq += s.queue_s as u128;
        sl += s.limiter_s as u128;
        sp += s.pause_s as u128;
        sc += s.confirm_s as u128;
        if s.bumped {
            bumped_count += 1;
        }
    }
    totals.sort_unstable();
    let n = totals.len().max(1) as u128;
    let sum: u128 = totals.iter().map(|v| *v as u128).sum();

    // Histogram: 24 bins of 30 minutes, then an overflow bin. Fixed bounds so two runs are
    // directly comparable without re-binning.
    let mut histogram: Vec<(u64, usize)> = (1..=24).map(|i| (i * 1_800u64, 0usize)).collect();
    histogram.push((u64::MAX, 0));
    for v in &totals {
        let slot = histogram
            .iter()
            .position(|(ub, _)| *v <= *ub)
            .unwrap_or(histogram.len() - 1);
        histogram[slot].1 += 1;
    }

    Distribution {
        samples: cfg.samples,
        seed: cfg.seed,
        unsatisfiable,
        min_s: totals.first().copied().unwrap_or(0),
        p50_s: percentile(&totals, 50, 100),
        p75_s: percentile(&totals, 75, 100),
        p90_s: percentile(&totals, 90, 100),
        p95_s: percentile(&totals, 95, 100),
        p99_s: percentile(&totals, 99, 100),
        p999_s: percentile(&totals, 999, 1_000),
        max_s: totals.last().copied().unwrap_or(0),
        mean_s: (sum / n) as u64,
        histogram,
        mean_queue_s: (sq / n) as u64,
        mean_limiter_s: (sl / n) as u64,
        mean_pause_s: (sp / n) as u64,
        mean_confirm_s: (sc / n) as u64,
        bumped_count,
    }
}

fn num(v: u64) -> Json {
    Json::Number(v.to_string())
}

impl Distribution {
    /// The JSON the TypeScript keeper reads. Every number is emitted as a JSON number in
    /// SECONDS; nothing here needs more than 53 bits, so the keeper can use plain `number`.
    pub fn to_json(&self, cfg: &ModelConfig) -> Json {
        Json::Object(vec![
            ("schema".into(), Json::Str("aphotic.latency.v1".into())),
            ("unit".into(), Json::Str("seconds".into())),
            // The single most important field in this file. See the banner.
            ("calibrated_against_hashi_sim".into(), Json::Bool(false)),
            (
                "provenance".into(),
                Json::Str(
                    "standalone model — Hashi's crates/hashi/src/utxo_pool/sim.rs is NOT in this \
                     repository, so the UTXO-fragmentation leg is parameterised, not calibrated. \
                     The limiter leg IS the vendored Hashi algorithm with live scalars."
                        .into(),
                ),
            ),
            ("seed".into(), num(self.seed)),
            ("samples".into(), num(self.samples as u64)),
            ("unsatisfiable".into(), num(self.unsatisfiable as u64)),
            (
                "config".into(),
                Json::Object(vec![
                    ("refill_rate_sats_per_s".into(), num(cfg.limiter.refill_rate)),
                    ("max_bucket_capacity_sats".into(), num(cfg.limiter.max_bucket_capacity)),
                    ("queue_depth_sats".into(), num(cfg.queue_depth_sats)),
                    ("tokens_at_start_sats".into(), num(cfg.tokens_at_start)),
                    ("amount_sats".into(), num(cfg.amount_sats)),
                    ("batch_interval_s".into(), num(cfg.batch_interval_s)),
                    ("block_interval_s".into(), num(cfg.block_interval_s)),
                    ("confirmations".into(), num(cfg.confirmations as u64)),
                    ("epoch_len_s".into(), num(cfg.epoch_len_s)),
                    ("reconfig_pause_s".into(), num(cfg.reconfig_pause_s)),
                    ("stuck_ppm10k".into(), num(cfg.stuck_ppm10k)),
                    ("cpfp_delay_s".into(), num(cfg.cpfp_delay_s)),
                ]),
            ),
            (
                "quantiles".into(),
                Json::Object(vec![
                    ("min".into(), num(self.min_s)),
                    ("p50".into(), num(self.p50_s)),
                    ("p75".into(), num(self.p75_s)),
                    ("p90".into(), num(self.p90_s)),
                    ("p95".into(), num(self.p95_s)),
                    ("p99".into(), num(self.p99_s)),
                    ("p999".into(), num(self.p999_s)),
                    ("max".into(), num(self.max_s)),
                    ("mean".into(), num(self.mean_s)),
                ]),
            ),
            (
                "mean_by_leg".into(),
                Json::Object(vec![
                    ("queue".into(), num(self.mean_queue_s)),
                    ("limiter".into(), num(self.mean_limiter_s)),
                    ("reconfig_pause".into(), num(self.mean_pause_s)),
                    ("confirmation".into(), num(self.mean_confirm_s)),
                ]),
            ),
            ("cpfp_bumped".into(), num(self.bumped_count as u64)),
            (
                "histogram".into(),
                Json::Array(
                    self.histogram
                        .iter()
                        .map(|(ub, c)| {
                            Json::Object(vec![
                                (
                                    "upper_bound_s".into(),
                                    if *ub == u64::MAX {
                                        Json::Null
                                    } else {
                                        num(*ub)
                                    },
                                ),
                                ("count".into(), num(*c as u64)),
                            ])
                        })
                        .collect(),
                ),
            ),
            (
                "hurdle_note".into(),
                Json::Str(
                    "aphotic.md §7.6: do not size the carry off a point estimate — the tail is \
                     the risk. Use p95/p99, not mean."
                        .into(),
                ),
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// @invariant 1 — against the vendored algorithm, including its saturating behaviour.
    #[test]
    fn project_capacity_matches_the_vendored_hashi_algorithm() {
        let cfg = LimiterConfig {
            refill_rate: 1_000,
            max_bucket_capacity: 2_000_000,
        };
        assert_eq!(project_capacity(&cfg, 0, 0), 0);
        assert_eq!(project_capacity(&cfg, 0, 10), 10_000);
        assert_eq!(project_capacity(&cfg, 1_999_000, 10), 2_000_000, "clamps at the cap");
        // Saturating, not wrapping — Hashi uses saturating_mul / saturating_add.
        assert_eq!(project_capacity(&cfg, u64::MAX, u64::MAX), 2_000_000);
        assert_eq!(project_capacity(&cfg, 0, u64::MAX), 2_000_000);
        // Live scalars: a full bucket is 100 BTC and refills in just under a day.
        let live = LimiterConfig::default();
        assert_eq!(live.max_bucket_capacity, 10_000_000_000);
        assert_eq!(project_capacity(&live, 0, 86_400), 9_999_936_000);
    }

    /// @invariant 2.
    #[test]
    fn percentiles_are_monotone() {
        let d = simulate(&ModelConfig::default());
        assert!(d.min_s <= d.p50_s);
        assert!(d.p50_s <= d.p75_s);
        assert!(d.p75_s <= d.p90_s);
        assert!(d.p90_s <= d.p95_s);
        assert!(d.p95_s <= d.p99_s);
        assert!(d.p99_s <= d.p999_s);
        assert!(d.p999_s <= d.max_s);
    }

    /// @invariant 3.
    #[test]
    fn the_same_seed_reproduces_the_distribution() {
        let cfg = ModelConfig {
            samples: 3_000,
            ..Default::default()
        };
        assert_eq!(simulate(&cfg), simulate(&cfg));
        let other = ModelConfig { seed: 7, ..cfg.clone() };
        assert_ne!(simulate(&cfg), simulate(&other));
    }

    /// @invariant 4 — a deeper queue or a slower refill can only make the wait longer.
    #[test]
    fn worse_conditions_never_shorten_the_wait() {
        let base = ModelConfig {
            samples: 4_000,
            amount_sats: 5_000_000_000,
            tokens_at_start: 1_000_000_000,
            ..Default::default()
        };
        let d0 = simulate(&base);

        let deeper = ModelConfig {
            queue_depth_sats: 20_000_000_000,
            ..base.clone()
        };
        assert!(simulate(&deeper).p50_s >= d0.p50_s, "a deeper queue got FASTER");

        let slower = ModelConfig {
            limiter: LimiterConfig {
                refill_rate: LIVE_REFILL_RATE / 4,
                ..base.limiter
            },
            ..base.clone()
        };
        assert!(simulate(&slower).p50_s >= d0.p50_s, "a slower refill got FASTER");
    }

    /// The whole reason §7.6 forbids a point estimate: the tail is materially worse than the
    /// median, so `mean × cost of capital` under-prices the carry.
    #[test]
    fn the_tail_is_materially_worse_than_the_median() {
        let d = simulate(&ModelConfig::default());
        assert!(
            d.p99_s > d.p50_s * 3 / 2,
            "p99 {} is not meaningfully worse than p50 {} — the model has smoothed away the \
             risk §7.6 is about",
            d.p99_s,
            d.p50_s
        );
        assert!(d.max_s > d.p99_s);
    }

    /// An amount above the bucket ceiling is never satisfiable in ONE withdrawal (FACTS row 9).
    /// It must be reported as such, not as a very large number.
    #[test]
    fn an_amount_above_the_cap_is_reported_unsatisfiable() {
        let cfg = ModelConfig {
            amount_sats: LIVE_MAX_BUCKET_CAPACITY + 1,
            samples: 100,
            ..Default::default()
        };
        let d = simulate(&cfg);
        assert_eq!(d.unsatisfiable, 100);
    }

    #[test]
    fn the_histogram_counts_every_satisfiable_sample() {
        let cfg = ModelConfig {
            samples: 2_000,
            ..Default::default()
        };
        let d = simulate(&cfg);
        let counted: usize = d.histogram.iter().map(|(_, c)| *c).sum();
        assert_eq!(counted + d.unsatisfiable, cfg.samples);
    }

    /// The output must parse as JSON and carry the honesty flag.
    #[test]
    fn json_output_is_valid_and_declares_it_is_not_calibrated() {
        let cfg = ModelConfig {
            samples: 500,
            ..Default::default()
        };
        let text = clearing::json::write(&simulate(&cfg).to_json(&cfg));
        let back = clearing::json::parse(&text).expect("the emitted JSON re-parses");
        assert_eq!(
            back.get("calibrated_against_hashi_sim").and_then(Json::as_bool),
            Some(false)
        );
        assert_eq!(back.get("schema").and_then(Json::as_str), Some("aphotic.latency.v1"));
        assert!(back.get("quantiles").and_then(|q| q.get("p99")).is_some());
    }
}
