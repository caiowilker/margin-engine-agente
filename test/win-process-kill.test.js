#!/usr/bin/env node
/**
 * P2a — killProcessTree com confirmação + contrato RAW (sem execFileSync).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const {
  killProcessTree,
  isPidAlive,
  isAlreadyGoneMessage,
} = require("../print/winProcessKill");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      console.error(`  ✗ ${name}:`, e.message);
    });
}

async function run() {
  await test("isAlreadyGoneMessage reconhece 'not found'", () => {
    assert.equal(isAlreadyGoneMessage("ERROR: The process thr not found."), true);
    assert.equal(isAlreadyGoneMessage("Access denied"), false);
  });

  await test("killProcessTree sem pid → confirmedDead sem attempt", async () => {
    const r = await killProcessTree(null, { logResult: false, reason: "test" });
    assert.equal(r.attempted, false);
    assert.equal(r.confirmedDead, true);
    assert.equal(r.stillAlive, false);
  });

  await test("killProcessTree mata child Node e confirma morte", async () => {
    const child = execFile(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], () => {});
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(child.pid > 0);
    assert.equal(isPidAlive(child.pid), true);
    const r = await killProcessTree(child.pid, {
      reason: "unit_test",
      logResult: false,
      metric: "print.taskkill_attempt",
    });
    assert.equal(r.attempted, true);
    assert.equal(r.confirmedDead, true, JSON.stringify(r));
    assert.equal(r.stillAlive, false);
    assert.equal(isPidAlive(child.pid), false);
  });

  await test("P2b: impressoraCore não usa execFileSync no path RAW", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../print/escpos/impressoraCore.js"),
      "utf8",
    );
    assert.ok(
      !/\bexecFileSync\s*\(/.test(src),
      "P2b: chamada execFileSync proibida no RAW",
    );
    assert.ok(src.includes("killProcessTree"));
    assert.ok(src.includes("print.taskkill_attempt"));
    assert.ok(src.includes("print.child_exit"));
    assert.ok(src.includes("print.taskkill_still_alive"));
    assert.ok(src.includes("print.raw_kill_confirmed_release"));
    assert.ok(src.includes("RAW_KILL_HOLD_MS"));
    assert.ok(src.includes("requestKill"));
    assert.ok(src.includes("printTimedOut"));
  });

  await test("parseRawTimingFromStdout extrai JSON e aponta WritePrinter lento", () => {
    const core = require("../print/escpos/impressoraCore");
    const t = core.__test.parseRawTimingFromStdout(
      'ok\nRAW_TIMING_JSON:{"OpenPrinter":1,"WritePrinter":125000,"EndDocPrinter":2,"totalMs":125010}\n',
    );
    assert.ok(t);
    assert.equal(t.WritePrinter, 125000);
    assert.equal(t.totalMs, 125010);
    assert.equal(core.__test.parseRawTimingFromStdout("sem timing"), null);
  });

  await test("P2a: soft timeout rejeita rápido com child zombie", async () => {
    const { killProcessTree: kill } = require("../print/winProcessKill");
    const t0 = Date.now();
    const child = execFile(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], () => {});
    await new Promise((resolve, reject) => {
      let settled = false;
      const soft = setTimeout(() => {
        void kill(child.pid, { reason: "raw_soft_timeout", logResult: false }).then((kr) => {
          assert.equal(kr.confirmedDead, true);
        });
        try {
          child.kill();
        } catch (_) {}
        if (!settled) {
          settled = true;
          reject(new Error("RAW Windows timeout (200ms): mock"));
        }
      }, 200);
      child.on("exit", () => {
        clearTimeout(soft);
        if (!settled) {
          settled = true;
          resolve(true);
        }
      });
    }).then(
      () => {
        throw new Error("deveria ter rejeitado por timeout");
      },
      (err) => {
        const ms = Date.now() - t0;
        assert.ok(/timeout/i.test(err.message), err.message);
        assert.ok(ms < 3000, `timeout demorou demais: ${ms}ms`);
      },
    );
  });

  console.log(`\nwin-process-kill: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
