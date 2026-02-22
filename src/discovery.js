import { CONFIG } from "./config.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("DISCOVERY");

const PRE_FETCH_MS = 5000; // fetch next market 5s before current expires

/**
 * MarketDiscovery — auto-discovers and rotates crypto Up/Down contracts.
 *
 * Parametrized by asset (BTC, ETH, SOL) and window length (5m, 15m).
 * Uses the Gamma API to find the current market by its predictable slug:
 *   {asset}-updown-{window}m-{unix_timestamp}
 *
 * where the unix timestamp is aligned to (windowMins × 60)-second boundaries.
 * All contracts resolve via Chainlink CEX aggregated price feeds.
 */
export class MarketDiscovery {
  constructor(asset, windowMins) {
    this.asset = asset.toLowerCase();
    this.windowMins = windowMins;
    this.intervalSecs = windowMins * 60;
    this._rotationTimer = null;
    this.currentMarket = null;
  }

  /** Floor a unix timestamp (seconds) to the nearest window boundary. */
  _alignToInterval(tsSec) {
    return Math.floor(tsSec / this.intervalSecs) * this.intervalSecs;
  }

  /** Build the Gamma API slug for a given aligned timestamp. */
  _buildSlug(alignedTs) {
    return `${this.asset}-updown-${this.windowMins}m-${alignedTs}`;
  }

  /**
   * Fetch a market from Gamma API by its aligned timestamp.
   * Returns normalized market object or null if not found / not tradeable.
   */
  async fetchMarket(alignedTs) {
    const slug = this._buildSlug(alignedTs);
    const url = `${CONFIG.poly.gammaApiUrl}/markets/slug/${slug}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        log.debug(`Market not found: ${slug} (HTTP ${resp.status})`);
        return null;
      }

      const data = await resp.json();

      if (data.closed || !data.active) {
        log.debug(`Market ${slug} is closed or inactive`);
        return null;
      }

      // clobTokenIds is returned as a JSON-encoded string by the Gamma API
      let tokenIds = data.clobTokenIds;
      if (typeof tokenIds === "string") {
        try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; }
      }
      if (!Array.isArray(tokenIds) || tokenIds.length < 2) {
        log.warn(`Market ${slug} missing clobTokenIds`);
        return null;
      }

      const market = {
        asset: this.asset.toUpperCase(),
        windowMins: this.windowMins,
        conditionId: data.conditionId,
        tokenIdYes: tokenIds[0],
        tokenIdNo: tokenIds[1],
        endDate: data.endDate,
        startTime: data.events?.[0]?.startTime || null,
        slug,
        acceptingOrders: data.acceptingOrders !== false,
      };

      log.info("Fetched market", {
        slug,
        conditionId: market.conditionId?.slice(0, 10) + "...",
        endDate: market.endDate,
        accepting: market.acceptingOrders,
      });

      return market;
    } catch (err) {
      log.error(`Failed to fetch market ${slug}`, { error: err.message });
      return null;
    }
  }

  /**
   * Find the current active market.
   * Tries the current window first; if that market is expired/closed,
   * tries the next window.
   */
  async findCurrentMarket() {
    const nowSec = Math.floor(Date.now() / 1000);
    const currentTs = this._alignToInterval(nowSec);

    log.info(`[${this.asset.toUpperCase()}/${this.windowMins}m] Looking for market at window ${currentTs} (${new Date(currentTs * 1000).toISOString()})`);

    // Try current window
    let market = await this.fetchMarket(currentTs);
    if (market && market.acceptingOrders) {
      this.currentMarket = market;
      return market;
    }

    // Current window closed/expired — try next window
    const nextTs = currentTs + this.intervalSecs;
    log.info(`Current window closed, trying next: ${nextTs} (${new Date(nextTs * 1000).toISOString()})`);
    market = await this.fetchMarket(nextTs);
    if (market) {
      this.currentMarket = market;
      return market;
    }

    log.warn(`[${this.asset.toUpperCase()}/${this.windowMins}m] No active market found in current or next window`);
    return null;
  }

  /**
   * Start automatic market rotation.
   * Schedules a timer to pre-fetch the next market ~5s before the current
   * one expires, then calls onNewMarket with the fresh market data.
   */
  startRotation(onNewMarket) {
    if (!this.currentMarket?.endDate) {
      log.warn("Cannot start rotation — no current market with endDate");
      return;
    }

    this._scheduleNext(onNewMarket);
  }

  _scheduleNext(onNewMarket) {
    if (this._rotationTimer) clearTimeout(this._rotationTimer);

    const endMs = new Date(this.currentMarket.endDate).getTime();
    const rotateAt = endMs - PRE_FETCH_MS;
    const delay = Math.max(rotateAt - Date.now(), 1000); // at least 1s from now

    log.info(`[${this.asset.toUpperCase()}/${this.windowMins}m] Next rotation in ${(delay / 1000).toFixed(0)}s (market ends ${this.currentMarket.endDate})`);

    this._rotationTimer = setTimeout(async () => {
      try {
        // Compute the next window timestamp
        const endSec = Math.floor(endMs / 1000);
        const nextTs = this._alignToInterval(endSec) + this.intervalSecs;

        log.info(`[${this.asset.toUpperCase()}/${this.windowMins}m] Rotating to next market window: ${nextTs}`);
        const nextMarket = await this.fetchMarket(nextTs);

        if (nextMarket) {
          this.currentMarket = nextMarket;
          await onNewMarket(nextMarket);
          this._scheduleNext(onNewMarket);
        } else {
          // Retry after a short delay — market may not be created yet
          log.warn("Next market not available yet, retrying in 10s...");
          this._rotationTimer = setTimeout(async () => {
            const retryMarket = await this.findCurrentMarket();
            if (retryMarket) {
              await onNewMarket(retryMarket);
              this._scheduleNext(onNewMarket);
            } else {
              log.error("Failed to find next market after retry");
              this._scheduleNext(onNewMarket);
            }
          }, 10000);
        }
      } catch (err) {
        log.error("Rotation failed", { error: err.message });
        this._rotationTimer = setTimeout(() => this._scheduleNext(onNewMarket), 15000);
      }
    }, delay);
  }

  stop() {
    if (this._rotationTimer) {
      clearTimeout(this._rotationTimer);
      this._rotationTimer = null;
    }
  }
}
