import { CONFIG } from "./config.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("DISCOVERY");

const INTERVAL_SECS = 300; // 5-minute markets
const PRE_FETCH_MS = 5000; // fetch next market 5s before current expires

/**
 * MarketDiscovery — auto-discovers and rotates BTC Up/Down 5m contracts.
 *
 * Uses the Gamma API to find the current market by its predictable slug:
 *   btc-updown-5m-{unix_timestamp}
 *
 * where the unix timestamp is aligned to 300-second boundaries.
 */
export class MarketDiscovery {
  constructor() {
    this._rotationTimer = null;
    this.currentMarket = null;
  }

  /** Floor a unix timestamp (seconds) to the nearest 5-minute boundary. */
  _alignToInterval(tsSec) {
    return Math.floor(tsSec / INTERVAL_SECS) * INTERVAL_SECS;
  }

  /** Build the Gamma API slug for a given aligned timestamp. */
  _buildSlug(alignedTs) {
    return `btc-updown-5m-${alignedTs}`;
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

      const tokenIds = data.clobTokenIds;
      if (!tokenIds || tokenIds.length < 2) {
        log.warn(`Market ${slug} missing clobTokenIds`);
        return null;
      }

      const market = {
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
   * Tries the current 5-minute window first; if that market is expired/closed,
   * tries the next window.
   */
  async findCurrentMarket() {
    const nowSec = Math.floor(Date.now() / 1000);
    const currentTs = this._alignToInterval(nowSec);

    log.info(`Looking for market at window ${currentTs} (${new Date(currentTs * 1000).toISOString()})`);

    // Try current window
    let market = await this.fetchMarket(currentTs);
    if (market && market.acceptingOrders) {
      this.currentMarket = market;
      return market;
    }

    // Current window closed/expired — try next window
    const nextTs = currentTs + INTERVAL_SECS;
    log.info(`Current window closed, trying next: ${nextTs} (${new Date(nextTs * 1000).toISOString()})`);
    market = await this.fetchMarket(nextTs);
    if (market) {
      this.currentMarket = market;
      return market;
    }

    log.warn("No active market found in current or next window");
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

    log.info(`Next rotation in ${(delay / 1000).toFixed(0)}s (market ends ${this.currentMarket.endDate})`);

    this._rotationTimer = setTimeout(async () => {
      try {
        // Compute the next window timestamp
        const endSec = Math.floor(endMs / 1000);
        const nextTs = this._alignToInterval(endSec) + INTERVAL_SECS;

        log.info(`Rotating to next market window: ${nextTs}`);
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
              // Keep trying every 30s
              this._scheduleNext(onNewMarket);
            }
          }, 10000);
        }
      } catch (err) {
        log.error("Rotation failed", { error: err.message });
        // Schedule retry
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
