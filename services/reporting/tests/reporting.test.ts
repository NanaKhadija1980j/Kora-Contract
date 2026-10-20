/**
 * Reporting Service — Test Suite
 *
 * Covers:
 *  - StatementBuilder: per-user statement with date-range filtering
 *  - StatementBuilder: multi-asset separation (USDC and EURC never conflated)
 *  - StatementBuilder: reproducibility (same inputs → identical output)
 *  - StatementBuilder: protocol-wide aggregate
 *  - CsvRenderer: per-user CSV structure
 *  - CsvRenderer: protocol-wide CSV structure
 *  - ExportJobQueue: enqueue → async processing → ready status
 *  - ExportJobQueue: per_user scope validation
 *  - ExportJobQueue: failed job captures error message
 *  - ExportJobQueue: large export async completion flow
 *  - ExportJobQueue: listJobs pagination
 *
 * Issue #770 — Minimum 90% coverage.
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { StatementBuilder } from "../src/statementBuilder";
import { CsvRenderer } from "../src/csvRenderer";
import {
  ExportJobQueue,
  ReportingDataSource,
} from "../src/exportJobQueue";
import {
  FundingEvent,
  RepaymentEvent,
  YieldEvent,
  FeeEvent,
  UserStatement,
  ProtocolStatement,
} from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_TS = 1_700_000_000; // fixed reference timestamp

function fundingEvent(asset: string, amount: bigint, offset = 0): FundingEvent {
  return {
    invoiceId: `inv-${asset}-${offset}`,
    asset,
    amount,
    timestamp: BASE_TS + offset,
    txHash: `0xfund${offset}`,
  };
}

function repaymentEvent(asset: string, amount: bigint, offset = 0): RepaymentEvent {
  return {
    invoiceId: `inv-${asset}-${offset}`,
    asset,
    amount,
    timestamp: BASE_TS + offset,
    txHash: `0xrepay${offset}`,
  };
}

function yieldEvent(asset: string, principal: bigint, yieldAmt: bigint, offset = 0): YieldEvent {
  return {
    invoiceId: `inv-${asset}-${offset}`,
    asset,
    principalReturned: principal,
    yieldAmount: yieldAmt,
    timestamp: BASE_TS + offset,
    txHash: `0xyield${offset}`,
  };
}

function feeEvent(asset: string, feeAmount: bigint, offset = 0): FeeEvent {
  return {
    invoiceId: `inv-${asset}-${offset}`,
    asset,
    feeAmount,
    feeBps: 50,
    timestamp: BASE_TS + offset,
    txHash: `0xfee${offset}`,
  };
}

// ---------------------------------------------------------------------------
// StatementBuilder tests
// ---------------------------------------------------------------------------

describe("StatementBuilder", () => {
  const builder = new StatementBuilder();

  test("builds a per-user statement with correct event counts", () => {
    const stmt = builder.buildUserStatement(
      "GBuser",
      BASE_TS,
      BASE_TS + 1000,
      [fundingEvent("USDC", 1000n)],
      [repaymentEvent("USDC", 1000n, 100)],
      [yieldEvent("USDC", 1000n, 50n, 200)],
      [feeEvent("USDC", 5n, 50)]
    );
    expect(stmt.funding).toHaveLength(1);
    expect(stmt.repayments).toHaveLength(1);
    expect(stmt.yields).toHaveLength(1);
    expect(stmt.fees).toHaveLength(1);
  });

  test("filters out events outside the date range", () => {
    const beforeRange = fundingEvent("USDC", 100n, -10); // before fromTs
    const afterRange = fundingEvent("USDC", 200n, 2000); // after toTs
    const inRange = fundingEvent("USDC", 300n, 500);

    const stmt = builder.buildUserStatement(
      "GBuser",
      BASE_TS,
      BASE_TS + 1000,
      [beforeRange, inRange, afterRange],
      [], [], []
    );
    expect(stmt.funding).toHaveLength(1);
    expect(stmt.funding[0].amount).toBe(300n);
  });

  test("multi-asset: USDC and EURC totals are never conflated", () => {
    const stmt = builder.buildUserStatement(
      "GBuser",
      BASE_TS,
      BASE_TS + 9999,
      [
        fundingEvent("USDC", 1_000_000n),
        fundingEvent("EURC", 500_000n),
      ],
      [],
      [],
      []
    );

    const usdc = stmt.summaryByAsset.find((s) => s.asset === "USDC");
    const eurc = stmt.summaryByAsset.find((s) => s.asset === "EURC");
    expect(usdc).toBeDefined();
    expect(eurc).toBeDefined();
    expect(usdc!.totalFunded).toBe(1_000_000n);
    expect(eurc!.totalFunded).toBe(500_000n);
    // The two must not have been added together anywhere
    expect(usdc!.totalFunded + eurc!.totalFunded).toBe(1_500_000n);
    expect(stmt.summaryByAsset.find((s) => s.totalFunded === 1_500_000n)).toBeUndefined();
  });

  test("reproducibility: same inputs produce identical output", () => {
    const args: Parameters<typeof builder.buildUserStatement> = [
      "GBuser",
      BASE_TS,
      BASE_TS + 9999,
      [fundingEvent("USDC", 1000n), fundingEvent("EURC", 500n)],
      [repaymentEvent("USDC", 1000n, 500)],
      [yieldEvent("USDC", 1000n, 50n, 600)],
      [feeEvent("USDC", 5n, 100)],
    ];
    const result1 = builder.buildUserStatement(...args);
    const result2 = builder.buildUserStatement(...args);
    expect(JSON.stringify(result1, replacer)).toBe(JSON.stringify(result2, replacer));
  });

  test("builds a protocol-wide statement with correct invoice counts", () => {
    const stmt = builder.buildProtocolStatement(
      BASE_TS,
      BASE_TS + 9999,
      100,
      80,
      5,
      [fundingEvent("USDC", 1000n)],
      [repaymentEvent("USDC", 1000n, 100)],
      [yieldEvent("USDC", 1000n, 50n, 200)],
      [feeEvent("USDC", 5n, 50)]
    );
    expect(stmt.totalInvoicesFinanced).toBe(100);
    expect(stmt.totalInvoicesRepaid).toBe(80);
    expect(stmt.totalInvoicesDefaulted).toBe(5);
    expect(stmt.summaryByAsset[0].totalFunded).toBe(1000n);
  });

  test("protocol-wide multi-asset: no cross-asset conflation", () => {
    const stmt = builder.buildProtocolStatement(
      BASE_TS,
      BASE_TS + 9999,
      10,
      8,
      1,
      [fundingEvent("USDC", 1_000n), fundingEvent("EURC", 2_000n)],
      [],
      [],
      []
    );
    const usdc = stmt.summaryByAsset.find((s) => s.asset === "USDC");
    const eurc = stmt.summaryByAsset.find((s) => s.asset === "EURC");
    expect(usdc!.totalFunded).toBe(1_000n);
    expect(eurc!.totalFunded).toBe(2_000n);
  });
});

// ---------------------------------------------------------------------------
// CsvRenderer tests
// ---------------------------------------------------------------------------

describe("CsvRenderer", () => {
  const renderer = new CsvRenderer();
  const builder = new StatementBuilder();

  function makeStmt(): ReturnType<typeof builder.buildUserStatement> {
    return builder.buildUserStatement(
      "GBuserADDR",
      BASE_TS,
      BASE_TS + 9999,
      [fundingEvent("USDC", 5_000_000_000n)],
      [repaymentEvent("USDC", 5_000_000_000n, 500)],
      [yieldEvent("USDC", 5_000_000_000n, 250_000_000n, 600)],
      [feeEvent("USDC", 25_000_000n, 100)]
    );
  }

  test("CSV contains header sections", () => {
    const csv = renderer.renderUserStatement(makeStmt());
    expect(csv).toContain("## Funding");
    expect(csv).toContain("## Repayments");
    expect(csv).toContain("## Yield");
    expect(csv).toContain("## Fees");
    expect(csv).toContain("## Summary by Asset");
  });

  test("CSV contains the user address", () => {
    const csv = renderer.renderUserStatement(makeStmt());
    expect(csv).toContain("GBuserADDR");
  });

  test("CSV contains correct amount values", () => {
    const csv = renderer.renderUserStatement(makeStmt());
    expect(csv).toContain("5000000000");
  });

  test("CSV is reproducible", () => {
    const stmt = makeStmt();
    expect(renderer.renderUserStatement(stmt)).toBe(renderer.renderUserStatement(stmt));
  });

  test("protocol CSV contains invoice count section", () => {
    const stmt = builder.buildProtocolStatement(
      BASE_TS, BASE_TS + 9999, 50, 40, 2,
      [fundingEvent("USDC", 1000n)], [], [], []
    );
    const csv = renderer.renderProtocolStatement(stmt);
    expect(csv).toContain("total_invoices_financed,50");
    expect(csv).toContain("total_invoices_repaid,40");
    expect(csv).toContain("total_invoices_defaulted,2");
  });
});

// ---------------------------------------------------------------------------
// ExportJobQueue tests
// ---------------------------------------------------------------------------

function makeDataSource(): ReportingDataSource {
  return {
    async getUserStatement(userAddress, fromTs, toTs): Promise<UserStatement> {
      return {
        userAddress,
        fromTs,
        toTs,
        funding: [fundingEvent("USDC", 1_000_000n)],
        repayments: [repaymentEvent("USDC", 1_000_000n, 100)],
        yields: [yieldEvent("USDC", 1_000_000n, 50_000n, 200)],
        fees: [feeEvent("USDC", 5_000n, 50)],
        summaryByAsset: [],
      };
    },
    async getProtocolStatement(fromTs, toTs): Promise<ProtocolStatement> {
      return {
        fromTs,
        toTs,
        totalInvoicesFinanced: 10,
        totalInvoicesRepaid: 8,
        totalInvoicesDefaulted: 1,
        summaryByAsset: [],
      };
    },
  };
}

describe("ExportJobQueue", () => {
  let dbPath: string;
  let outDir: string;
  let queue: ExportJobQueue;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `reporting-test-${Date.now()}.db`);
    outDir = path.join(os.tmpdir(), `reporting-out-${Date.now()}`);
    queue = new ExportJobQueue(dbPath, makeDataSource(), outDir);
  });

  afterEach(() => {
    queue.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true });
  });

  function waitForJob(jobId: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const job = queue.getJob(jobId);
        if (job && (job.status === "ready" || job.status === "failed")) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error(`Job ${jobId} did not complete in time`));
        }
      }, 50);
    });
  }

  test("enqueue returns a jobId", () => {
    const jobId = queue.enqueue({
      scope: "per_user",
      format: "csv",
      userAddress: "GBuser",
      fromTs: BASE_TS,
      toTs: BASE_TS + 9999,
    });
    expect(typeof jobId).toBe("string");
    expect(jobId.length).toBeGreaterThan(0);
  });

  test("throws if per_user scope has no userAddress", () => {
    expect(() =>
      queue.enqueue({ scope: "per_user", format: "csv", fromTs: BASE_TS, toTs: BASE_TS + 1 })
    ).toThrow("userAddress is required");
  });

  test("per-user CSV export completes asynchronously and file is written", async () => {
    const jobId = queue.enqueue({
      scope: "per_user",
      format: "csv",
      userAddress: "GBuser",
      fromTs: BASE_TS,
      toTs: BASE_TS + 9999,
    });
    await waitForJob(jobId);
    const job = queue.getJob(jobId);
    expect(job?.status).toBe("ready");
    expect(job?.outputPath).toBeDefined();
    expect(fs.existsSync(job!.outputPath!)).toBe(true);
  });

  test("protocol-wide CSV export completes asynchronously", async () => {
    const jobId = queue.enqueue({
      scope: "protocol_wide",
      format: "csv",
      fromTs: BASE_TS,
      toTs: BASE_TS + 9999,
    });
    await waitForJob(jobId);
    const job = queue.getJob(jobId);
    expect(job?.status).toBe("ready");
  });

  test("failed data source sets job status to failed", async () => {
    const failSource: ReportingDataSource = {
      async getUserStatement() {
        throw new Error("indexer unavailable");
      },
      async getProtocolStatement() {
        throw new Error("indexer unavailable");
      },
    };
    const failQueue = new ExportJobQueue(
      path.join(os.tmpdir(), `fail-${Date.now()}.db`),
      failSource,
      path.join(os.tmpdir(), `fail-out-${Date.now()}`)
    );
    const jobId = failQueue.enqueue({
      scope: "per_user",
      format: "csv",
      userAddress: "GBfail",
      fromTs: BASE_TS,
      toTs: BASE_TS + 9999,
    });
    await waitForJob(jobId);
    const job = failQueue.getJob(jobId);
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toContain("indexer unavailable");
    failQueue.close();
  });

  test("getJob returns null for unknown jobId", () => {
    expect(queue.getJob("nonexistent")).toBeNull();
  });

  test("listJobs returns all enqueued jobs", async () => {
    queue.enqueue({ scope: "per_user", format: "csv", userAddress: "GB1", fromTs: BASE_TS, toTs: BASE_TS + 1 });
    queue.enqueue({ scope: "per_user", format: "csv", userAddress: "GB2", fromTs: BASE_TS, toTs: BASE_TS + 1 });
    // Allow both to start processing
    await new Promise((r) => setTimeout(r, 10));
    const jobs = queue.listJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(2);
  });

  test("large export async completion: file is readable after completion", async () => {
    // Simulate a larger dataset by returning many events
    const largeSource: ReportingDataSource = {
      async getUserStatement(userAddress, fromTs, toTs): Promise<UserStatement> {
        const funding = Array.from({ length: 500 }, (_, i) =>
          fundingEvent("USDC", BigInt(i * 1000), i)
        );
        return {
          userAddress,
          fromTs,
          toTs,
          funding,
          repayments: [],
          yields: [],
          fees: [],
          summaryByAsset: [],
        };
      },
      async getProtocolStatement() {
        return { fromTs: 0, toTs: 1, totalInvoicesFinanced: 0, totalInvoicesRepaid: 0, totalInvoicesDefaulted: 0, summaryByAsset: [] };
      },
    };

    const largeDbPath = path.join(os.tmpdir(), `large-${Date.now()}.db`);
    const largeOutDir = path.join(os.tmpdir(), `large-out-${Date.now()}`);
    const largeQueue = new ExportJobQueue(largeDbPath, largeSource, largeOutDir);

    const jobId = largeQueue.enqueue({
      scope: "per_user",
      format: "csv",
      userAddress: "GBlarge",
      fromTs: BASE_TS,
      toTs: BASE_TS + 1_000_000,
    });

    await waitForJob(jobId, 10_000);
    const job = largeQueue.getJob(jobId);
    expect(job?.status).toBe("ready");

    const content = fs.readFileSync(job!.outputPath!, "utf8");
    // 500 funding rows
    const rows = content.split("\n").filter((l) => l.startsWith("inv-USDC-"));
    expect(rows.length).toBe(500);

    largeQueue.close();
    fs.unlinkSync(largeDbPath);
    fs.rmSync(largeOutDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
