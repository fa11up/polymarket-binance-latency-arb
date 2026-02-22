import blessed from "blessed";

/**
 * Terminal UI — renders a live dashboard using blessed.
 *
 * Layout (top → bottom):
 *   - Header bar      (1 line, no border)
 *   - Markets table   (1 row per active market)
 *   - Risk/stats row  (bankroll, P&L, feeds)
 *   - Log pane        (fills remaining height, scrollable)
 *
 * Usage:
 *   const tui = new TUI(marketCount);
 *   tui.render(data);    // call every second
 *   tui.log("message");  // append to log pane
 *   tui.destroy();       // restore terminal on exit
 */
export class TUI {
  constructor(marketCount = 1) {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "⚡ Latency Arb Engine",
      fullUnicode: true,
    });

    // Fixed heights for each section
    const marketsHeight = marketCount + 4; // top/bottom border + col header + N rows
    const statsHeight   = 5;               // top/bottom border + 3 data rows

    // ─── Header bar ──────────────────────────────────────────────────
    this.header = blessed.box({
      parent: this.screen,
      top: 0, left: 0, right: 0, height: 1,
      tags: true,
    });

    // ─── Markets table ───────────────────────────────────────────────
    this.marketsBox = blessed.box({
      parent: this.screen,
      top: 1, left: 0, right: 0, height: marketsHeight,
      label: " {bold}MARKETS{/bold} ",
      border: { type: "line" },
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } },
      tags: true,
      padding: { left: 1, right: 1 },
    });

    // ─── Risk / stats bar ────────────────────────────────────────────
    this.statsBox = blessed.box({
      parent: this.screen,
      top: 1 + marketsHeight, left: 0, right: 0, height: statsHeight,
      label: " {bold}RISK & EXECUTION{/bold} ",
      border: { type: "line" },
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } },
      tags: true,
      padding: { left: 1, right: 1 },
    });

    // ─── Log pane ────────────────────────────────────────────────────
    this.logBox = blessed.log({
      parent: this.screen,
      top: 1 + marketsHeight + statsHeight,
      left: 0, right: 0, bottom: 0,
      label: " {bold}LOG{/bold}  {dim}(scroll: ↑↓  |  q: quit){/dim} ",
      border: { type: "line" },
      style: { border: { fg: "cyan" }, label: { fg: "cyan" } },
      tags: false,
      scrollable: true,
      alwaysScroll: true,
      scrollback: 500,  // cap line buffer — prevents unbounded memory growth
      scrollbar: { ch: "▐", style: { fg: "cyan" } },
      mouse: true,
      keys: true,
    });

    // ─── Key bindings ────────────────────────────────────────────────
    this.screen.key(["q", "C-c"], () => process.emit("SIGINT"));

    this.screen.render();
  }

  /**
   * Redraw all panels with fresh data.
   * @param {object} data - { uptime, mode, markets[], poly, risk, execution }
   */
  render({ uptime, mode, markets, poly, risk, execution }) {
    const now = new Date().toISOString().slice(11, 19) + " UTC";
    const modeTag = mode === "DRY RUN" ? "{yellow-fg}DRY RUN{/yellow-fg}" : "{red-fg}{bold}LIVE{/bold}{/red-fg}";

    // Header
    this.header.setContent(
      `{bold}⚡ LATENCY ARB{/bold}  ${modeTag}  Bankroll: {bold}$${risk.bankroll.toFixed(2)}{/bold}  Uptime: ${uptime}m  {dim}${now}{/dim}`
    );

    // Markets table
    const cols = { label: 9, spot: 12, strike: 11, mid: 10, edge: 8, lag: 9 };
    const head =
      `{bold}{cyan-fg}` +
      `${"MARKET".padEnd(cols.label)} ` +
      `${"SPOT".padEnd(cols.spot)} ` +
      `${"STRIKE".padEnd(cols.strike)} ` +
      `${"MID".padEnd(cols.mid)} ` +
      `${"EDGE".padEnd(cols.edge)} ` +
      `${"LAG".padEnd(cols.lag)} ` +
      `WINDOW{/cyan-fg}{/bold}`;

    const rows = markets.map(({ bStats, sStats }) => {
      // Pad raw values BEFORE adding color tags — blessed strips tags when
      // rendering, but JS padEnd() counts tag chars and adds no padding if
      // the tagged string is already "wide" from JS's perspective.
      const dot    = bStats.connected ? "{green-fg}●{/green-fg}" : "{red-fg}●{/red-fg}";
      const label  = (sStats.label || "—").padEnd(cols.label - 2);
      const spot   = (sStats.spotPrice   ? `$${sStats.spotPrice.toFixed(2)}`           : "—").padEnd(cols.spot);
      const strike = (sStats.strikePrice ? `$${sStats.strikePrice.toFixed(2)}`         : "—").padEnd(cols.strike);
      const mid    = (sStats.contractMid ? `${(sStats.contractMid * 100).toFixed(1)}¢` : "—").padEnd(cols.mid);
      const lagStr = (sStats.feedLag != null ? `${sStats.feedLag}ms`                   : "—").padEnd(cols.lag);

      // Edge: pad first, color after
      let edgeStr;
      if (sStats.edge) {
        const padded = ((sStats.edge * 100).toFixed(1) + "%").padEnd(cols.edge);
        edgeStr = sStats.edge >= 0.03 ? `{green-fg}${padded}{/green-fg}` : padded;
      } else {
        edgeStr = "—".padEnd(cols.edge);
      }

      // Countdown to expiry of current window
      let expiry = "—";
      if (sStats.marketEndDate) {
        const sec = Math.round((new Date(sStats.marketEndDate).getTime() - Date.now()) / 1000);
        if (sec <= 0) {
          expiry = "{yellow-fg}expiring{/yellow-fg}";
        } else {
          const str = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
          expiry = sec < 90 ? `{yellow-fg}${str}{/yellow-fg}` : str;
        }
      }

      return `${dot} ${label} ${spot} ${strike} ${mid} ${edgeStr} ${lagStr} ${expiry}`;
    });

    this.marketsBox.setContent([head, ...rows].join("\n"));

    // Stats / risk
    const dailyColor = risk.dailyPnl  >= 0 ? "{green-fg}" : "{red-fg}";
    const totalColor = execution.pnlStats.sum >= 0 ? "{green-fg}" : "{red-fg}";
    const polyDot    = poly.connected ? "{green-fg}●{/green-fg}" : "{red-fg}●{/red-fg}";
    const bookIcon   = poly.lastBook  ? "{green-fg}✓{/green-fg}" : "{red-fg}✗{/red-fg}";

    this.statsBox.setContent([
      `Bankroll: {bold}$${risk.bankroll.toFixed(2)}{/bold}   Drawdown: ${risk.drawdownPct}   Open: ${risk.openPositions}/${risk.maxOpen}   Daily P&L: ${dailyColor}$${risk.dailyPnl.toFixed(2)}{/}`,
      `Total P&L: ${totalColor}$${execution.pnlStats.sum.toFixed(2)}{/}   Avg/trade: $${execution.pnlStats.mean.toFixed(2)}   Sharpe: ${execution.pnlStats.sharpe.toFixed(2)}   Trades: ${execution.pnlStats.n}   Win: ${(execution.last20WinRate * 100).toFixed(0)}%   Latency: ${execution.avgExecutionLatency}ms`,
      `Polymarket: ${polyDot} ${poly.messageCount} msgs   REST: ${poly.avgRestLatency}ms   Book: ${bookIcon}   Polls: ${poly.polls}`,
    ].join("\n"));

    this.screen.render();
  }

  /** Append a line to the scrollable log pane (strips ANSI escape codes). */
  log(line) {
    this.logBox.log(line.replace(/\x1b\[[0-9;]*m/g, ""));
  }

  destroy() {
    this.screen.destroy();
  }
}
