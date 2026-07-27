#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { TEST_SUITES, type TestLayer } from "../test/catalog.ts";

interface RunnerOptions {
  layer?: TestLayer;
  list: boolean;
  junit: boolean;
}

function parseOptions(args: string[]): RunnerOptions {
  const options: RunnerOptions = { list: false, junit: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--list") {
      options.list = true;
    } else if (argument === "--junit") {
      options.junit = true;
    } else if (argument === "--layer") {
      const layer = args[index + 1];
      if (layer !== "unit" && layer !== "integration") {
        throw new Error("--layer 必须是 unit 或 integration");
      }
      options.layer = layer;
      index += 1;
    } else {
      throw new Error(`未知测试参数：${argument}`);
    }
  }
  return options;
}

function printCatalog(): void {
  process.stdout.write("ID\tLAYER\tAREA\tFILE\tDESCRIPTION\n");
  for (const suite of TEST_SUITES) {
    process.stdout.write(
      `${suite.id}\t${suite.layer}\t${suite.area}\t${suite.file}\t${suite.description}\n`,
    );
  }
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.list) {
    printCatalog();
    return;
  }

  const selected = options.layer
    ? TEST_SUITES.filter((suite) => suite.layer === options.layer)
    : TEST_SUITES;
  if (selected.length === 0) throw new Error("没有匹配的测试套件");

  const nodeArguments = ["--experimental-strip-types", "--test"];
  if (options.junit) {
    await mkdir(resolve("test-results"), { recursive: true });
    nodeArguments.push(
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=junit",
      "--test-reporter-destination=test-results/node-tests.xml",
    );
  }
  nodeArguments.push(...selected.map((suite) => resolve("test", suite.file)));

  const child = spawn(process.execPath, nodeArguments, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`测试进程被信号 ${signal} 终止`));
      else resolveExit(code ?? 1);
    });
  });
  process.exitCode = exitCode;
}

await run();
