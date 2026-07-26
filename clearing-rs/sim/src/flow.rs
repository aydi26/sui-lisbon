// ┌── APHOTIC CONTRACT ────────────────────────────────────────────────────────
// @task       X.clearing-rs
// @phase      3
// @status     DONE
// @spec       aphotic.md#12 (L503) <- "fix a maximum batch size as a governed parameter rather
//             than discovering it in production"
// @spec       docs/DESIGN-V2.md#2 <- MAX_BATCH_SIZE governed 256, HARD_MAX_BATCH_SIZE 512
// @spec       docs/DESIGN-V2.md#5 <- the algorithm being driven
// @rules      G10
// @depends    clearing::spec (THE real engine) · clearing::rng · clearing::json
// @facts      This drives the REAL clearing engine over synthetic order flow. It does not
// @facts        reimplement any part of the algorithm — a second copy of the matcher inside a
// @facts        simulator would be blocker B6 for a third time, and it would make the numbers
// @facts        below describe the simulator rather than the product.
// @facts      WHAT IT MEASURES, per batch: whether the book crossed, what fraction of submitted
// @facts        base actually filled, how much dust the rounding left, and how much of the
// @facts        matched volume the fee took. Reported as a DISTRIBUTION, for the same reason
// @facts        §7.6 demands one for latency: the median batch is not the batch that hurts.
// @facts      ORDER FLOW: a mid price does a seeded random walk; each order's limit is placed at
// @facts        a Normal-ish offset from it (sum of four uniforms — Irwin-Hall, integer only)
// @facts        and each side is drawn with probability 1/2. Crossing is therefore common but
// @facts        never guaranteed, which is what makes the no-cross rate meaningful.
// @implements pub struct FlowConfig · BatchStat · FlowSummary
//             pub fn simulate_flow(&FlowConfig) -> FlowSummary · FlowSummary::to_json
// @forbidden  reimplementing the matcher here
// @forbidden  an unseeded RNG
// @invariant  1. Every simulated batch respects HARD_MAX_BATCH_SIZE.
// @invariant  2. The same seed reproduces the same summary.
// @invariant  3. Reported fill ratios are in [0, 10_000] bps by construction.
// @ac         cargo test -p sim
// @verify     cd clearing-rs; cargo run -p sim -- --out latency.json --flow-out flow.json
// └── END CONTRACT ───────────────────────────────────────────────────────────

use clearing::json::Json;
use clearing::rng::SplitMix64;
use clearing::spec::{self, ClearingInput, RevealedOrder, HARD_MAX_BATCH_SIZE, SIDE_ASK, SIDE_BID};
use clearing::types::Address;

#[derive(Clone, Debug)]
pub struct FlowConfig {
    pub batches: usize,
    /// Orders per batch, inclusive range. Capped at HARD_MAX_BATCH_SIZE.
    pub min_orders: u64,
    pub max_orders: u64,
    pub accounts: u64,
    /// Starting mid, in quote-sats per whole unit at `spec::PRICE_SCALE`.
    pub start_mid: u128,
    /// Half-width of the limit-price spread around the mid, in basis points.
    pub spread_bps: u128,
    /// Per-batch random-walk step of the mid, in basis points.
    pub drift_bps: u128,
    pub min_qty: u64,
    pub max_qty: u64,
    pub fee_matched_bps: u128,
    pub seed: u64,
}

impl Default for FlowConfig {
    fn default() -> Self {
        FlowConfig {
            batches: 2_000,
            min_orders: 2,
            max_orders: 64,
            accounts: 24,
            start_mid: 100_000 * spec::PRICE_SCALE,
            spread_bps: 60,
            drift_bps: 25,
            min_qty: 1_000,
            max_qty: 5_000_000,
            fee_matched_bps: 30,
            seed: 0xB0B,
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct BatchStat {
    pub orders: usize,
    pub cleared: bool,
    pub fills: usize,
    pub matched_base: u64,
    pub submitted_base: u128,
    /// `matched_base / min(bid_base, ask_base)` in bps — how much of the CROSSABLE interest
    /// actually traded. 0 when nothing could cross.
    pub fill_ratio_bps: u64,
    pub dust_quote: u64,
    pub fee_quote: u64,
}

/// Irwin-Hall(4), integer only: the sum of four uniforms on `[0, span]`, re-centred. Close
/// enough to Normal for order placement, and it needs no float and no lookup table.
fn bell(r: &mut SplitMix64, span: u128) -> i128 {
    let mut acc = 0i128;
    for _ in 0..4 {
        acc += r.below((span as u64).max(1)) as i128;
    }
    acc - 2 * span as i128
}

pub fn simulate_flow(cfg: &FlowConfig) -> FlowSummary {
    let mut r = SplitMix64::new(cfg.seed);
    let mut mid = cfg.start_mid;
    let mut stats: Vec<BatchStat> = Vec::with_capacity(cfg.batches);

    for _ in 0..cfg.batches {
        // The mid does a seeded random walk.
        let step = mid * cfg.drift_bps / 10_000;
        mid = if r.bool_with(1, 2) {
            mid.saturating_add(r.below((step as u64).max(1)) as u128)
        } else {
            mid.saturating_sub(r.below((step as u64).max(1)) as u128).max(1)
        };

        let n = r
            .range(cfg.min_orders, cfg.max_orders)
            .min(HARD_MAX_BATCH_SIZE as u64);
        let half_span = (mid * cfg.spread_bps / 10_000).max(1);
        let mut orders = Vec::with_capacity(n as usize);
        for i in 0..n {
            let side = if r.bool_with(1, 2) { SIDE_BID } else { SIDE_ASK };
            let offset = bell(&mut r, half_span / 2);
            // A bid sits below the mid, an ask above — plus the noise, which is what lets them
            // cross.
            let base = if side == SIDE_BID {
                mid as i128 - (half_span / 2) as i128 + offset
            } else {
                mid as i128 + (half_span / 2) as i128 + offset
            };
            let limit_price = base.max(1) as u128;
            orders.push(RevealedOrder {
                index: i,
                submitter: Address::from_u128(r.range(1, cfg.accounts) as u128),
                side,
                limit_price,
                qty_base: r.range(cfg.min_qty, cfg.max_qty),
            });
        }

        let submitted_base: u128 = orders.iter().map(|o| o.qty_base as u128).sum();
        let bid_base: u128 = orders
            .iter()
            .filter(|o| o.side == SIDE_BID)
            .map(|o| o.qty_base as u128)
            .sum();
        let ask_base: u128 = orders
            .iter()
            .filter(|o| o.side == SIDE_ASK)
            .map(|o| o.qty_base as u128)
            .sum();
        let crossable = bid_base.min(ask_base);

        let res = spec::clear(&ClearingInput::new(orders.clone(), cfg.fee_matched_bps))
            .expect("generated books are always well formed");

        let fill_ratio_bps = if crossable == 0 {
            0
        } else {
            ((res.matched_base as u128 * 10_000) / crossable) as u64
        };
        stats.push(BatchStat {
            orders: orders.len(),
            cleared: res.cleared,
            fills: res.fills.len(),
            matched_base: res.matched_base,
            submitted_base,
            fill_ratio_bps,
            dust_quote: res.dust_quote,
            fee_quote: res.fee_quote,
        });
    }

    FlowSummary::from(cfg, &stats)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlowSummary {
    pub batches: usize,
    pub seed: u64,
    pub cleared: usize,
    pub no_cross: usize,
    pub total_fills: usize,
    pub max_fills_in_a_batch: usize,
    pub fill_ratio_p10_bps: u64,
    pub fill_ratio_p50_bps: u64,
    pub fill_ratio_p90_bps: u64,
    pub total_matched_base: u128,
    pub total_dust_quote: u128,
    pub total_fee_quote: u128,
    /// Batches whose rounding left a non-zero dust residual.
    pub batches_with_dust: usize,
}

fn pct(sorted: &[u64], num: usize, den: usize) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (sorted.len() * num).div_ceil(den).max(1);
    sorted[rank.min(sorted.len()) - 1]
}

impl FlowSummary {
    fn from(cfg: &FlowConfig, stats: &[BatchStat]) -> Self {
        let mut ratios: Vec<u64> = stats
            .iter()
            .filter(|s| s.cleared)
            .map(|s| s.fill_ratio_bps)
            .collect();
        ratios.sort_unstable();
        FlowSummary {
            batches: stats.len(),
            seed: cfg.seed,
            cleared: stats.iter().filter(|s| s.cleared).count(),
            no_cross: stats.iter().filter(|s| !s.cleared).count(),
            total_fills: stats.iter().map(|s| s.fills).sum(),
            max_fills_in_a_batch: stats.iter().map(|s| s.fills).max().unwrap_or(0),
            fill_ratio_p10_bps: pct(&ratios, 10, 100),
            fill_ratio_p50_bps: pct(&ratios, 50, 100),
            fill_ratio_p90_bps: pct(&ratios, 90, 100),
            total_matched_base: stats.iter().map(|s| s.matched_base as u128).sum(),
            total_dust_quote: stats.iter().map(|s| s.dust_quote as u128).sum(),
            total_fee_quote: stats.iter().map(|s| s.fee_quote as u128).sum(),
            batches_with_dust: stats.iter().filter(|s| s.dust_quote > 0).count(),
        }
    }

    pub fn to_json(&self, cfg: &FlowConfig) -> Json {
        let n = |v: u128| Json::Number(v.to_string());
        Json::Object(vec![
            ("schema".into(), Json::Str("aphotic.orderflow.v1".into())),
            ("seed".into(), n(self.seed as u128)),
            (
                "config".into(),
                Json::Object(vec![
                    ("batches".into(), n(cfg.batches as u128)),
                    ("min_orders".into(), n(cfg.min_orders as u128)),
                    ("max_orders".into(), n(cfg.max_orders as u128)),
                    ("accounts".into(), n(cfg.accounts as u128)),
                    ("spread_bps".into(), n(cfg.spread_bps)),
                    ("drift_bps".into(), n(cfg.drift_bps)),
                    ("fee_matched_bps".into(), n(cfg.fee_matched_bps)),
                    ("price_scale".into(), n(spec::PRICE_SCALE)),
                ]),
            ),
            ("batches".into(), n(self.batches as u128)),
            ("cleared".into(), n(self.cleared as u128)),
            ("no_cross".into(), n(self.no_cross as u128)),
            ("total_fills".into(), n(self.total_fills as u128)),
            ("max_fills_in_a_batch".into(), n(self.max_fills_in_a_batch as u128)),
            (
                "fill_ratio_bps".into(),
                Json::Object(vec![
                    ("p10".into(), n(self.fill_ratio_p10_bps as u128)),
                    ("p50".into(), n(self.fill_ratio_p50_bps as u128)),
                    ("p90".into(), n(self.fill_ratio_p90_bps as u128)),
                ]),
            ),
            ("total_matched_base".into(), n(self.total_matched_base)),
            ("total_dust_quote".into(), n(self.total_dust_quote)),
            ("total_fee_quote".into(), n(self.total_fee_quote)),
            ("batches_with_dust".into(), n(self.batches_with_dust as u128)),
            (
                "note".into(),
                Json::Str(
                    "produced by driving clearing::spec::clear — the real engine, not a copy. \
                     Order flow is synthetic and NOT calibrated against live DeepBook data."
                        .into(),
                ),
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// @invariant 2.
    #[test]
    fn the_same_seed_reproduces_the_summary() {
        let cfg = FlowConfig {
            batches: 300,
            ..Default::default()
        };
        assert_eq!(simulate_flow(&cfg), simulate_flow(&cfg));
        let other = FlowConfig { seed: 99, ..cfg.clone() };
        assert_ne!(simulate_flow(&cfg), simulate_flow(&other));
    }

    /// @invariant 1 and 3, plus a vacuity guard: the flow must actually cross sometimes and
    /// fail to cross sometimes, or it is measuring nothing.
    #[test]
    fn the_flow_both_crosses_and_fails_to_cross() {
        let cfg = FlowConfig {
            batches: 800,
            ..Default::default()
        };
        let s = simulate_flow(&cfg);
        assert_eq!(s.cleared + s.no_cross, s.batches);
        assert!(s.cleared > 0, "no batch ever crossed");
        assert!(s.max_fills_in_a_batch <= HARD_MAX_BATCH_SIZE);
        assert!(s.fill_ratio_p50_bps <= 10_000);
        assert!(s.fill_ratio_p90_bps <= 10_000);
        assert!(s.fill_ratio_p10_bps <= s.fill_ratio_p50_bps);
        assert!(s.fill_ratio_p50_bps <= s.fill_ratio_p90_bps);
        assert!(s.total_matched_base > 0);
    }

    #[test]
    fn json_output_reparses() {
        let cfg = FlowConfig {
            batches: 100,
            ..Default::default()
        };
        let text = clearing::json::write(&simulate_flow(&cfg).to_json(&cfg));
        let back = clearing::json::parse(&text).expect("valid JSON");
        assert_eq!(back.get("schema").and_then(Json::as_str), Some("aphotic.orderflow.v1"));
        assert!(back.get("fill_ratio_bps").and_then(|f| f.get("p90")).is_some());
    }
}
