#!/usr/bin/env node

/**
 * These are utilities that are used by multiple scripts.
 */

import * as cp from "node:child_process";
import * as fs from "node:fs";
import path, { basename, dirname, normalize, relative } from "node:path";
import { normalize as normalizeWindows } from "node:path/win32";
import { hostname, tmpdir, release } from "node:os";
import { inspect } from "node:util";

export const isWindows = process.platform === "win32";
export const isMacOS = process.platform === "darwin";
export const isLinux = process.platform === "linux";
export const isBuildKite = process.env["BUILDKITE"] === "true";
export const isGithubAction = process.env["GITHUB_ACTIONS"] === "true";
export const isCI = isBuildKite || isGithubAction || process.env["CI"] === "true";
export const isVerbose = process.argv.includes("--verbose") || isCI;
export const isQuiet = process.argv.includes("--quiet");
export const isDebug = process.argv.includes("--debug") || process.env["DEBUG"] === "1";
export const isColorTerminal = isCI || process.stdout.isTTY;

/**
 * Machine properties.
 */

/**
 * Get a human-readable name for the operating system.
 * @returns {Promise<string | undefined>}
 */
export async function getOs() {
  if (isMacOS) {
    const [name, version, build] = await Promise.all(
      ["productName", "productVersion", "buildVersion"].map(property =>
        spawn("sw_vers", [`-${property}`], { silent: true, throwOnError: false }).then(
          ({ exitCode, stdout }) => exitCode === 0 && stdout.trim(),
        ),
      ),
    );
    if (!name) {
      return "macOS";
    }
    if (!version) {
      return name;
    }
    if (!build) {
      return `${name} ${version}`;
    }
    return `${name} ${version}+${build}`;
  }

  if (isLinux) {
    const { exitCode, stdout } = await spawn("lsb_release", ["--description", "--short"], {
      silent: true,
      throwOnError: false,
    });
    if (exitCode === 0) {
      return stdout.trim();
    }
    return "Linux";
  }

  if (isWindows) {
    const { exitCode, stdout } = spawn("cmd", ["/c", "ver"], {
      silent: true,
      throwOnError: false,
    });
    if (exitCode === 0) {
      return stdout.trim();
    }
    return "Windows";
  }
}

/**
 * Gets the Glibc version.
 * @returns {number | undefined}
 */
export function getGlibcVersion() {
  if (!isLinux) {
    return;
  }
  try {
    const { header } = process.report.getReport();
    const { glibcVersionRuntime } = header;
    const version = parseFloat(glibcVersionRuntime);
    if (isFinite(version)) {
      return version;
    }
  } catch {
    // ...
  }
}

/**
 * Gets the Linux kernel version.
 * @returns {string}
 */
export function getKernelVersion() {
  try {
    return release();
  } catch {
    // ...
  }
}

/**
 * Gets the hostname.
 * @returns {string}
 */
export function getHostname() {
  if (isBuildKite) {
    return process.env["BUILDKITE_AGENT_NAME"];
  }
  if (isGithubAction) {
    return process.env["RUNNER_NAME"];
  }
  try {
    return hostname();
  } catch {
    // ...
  }
}

/**
 * Gets the public IP address.
 * @returns {Promise<string | undefined>}
 */
export async function getPublicIp() {
  const urls = ["https://checkip.amazonaws.com", "https://ipinfo.io/ip", "https://icanhazip.com"];
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        continue;
      }
      const body = await response.text();
      const address = body.trim();
      if (!isIP(address)) {
        continue;
      }
      return address;
    } catch {
      continue;
    }
  }
}

/**
 * Gets the IP address of the Tailscale machine.
 * @returns {Promise<string | undefined>}
 */
export async function getTailscaleIp() {
  const { exitCode, stdout } = spawn("tailscale", ["ip", "--1"], {
    silent: true,
    throwOnError: false,
  });
  if (exitCode === 0) {
    const address = stdout.trim();
    if (isIP(address)) {
      return address;
    }
  }
}

/**
 * Gets the temporary directory.
 * @returns {string}
 */
export function getTmpdir() {
  if (isWindows) {
    for (const key of ["TMPDIR", "TEMP", "TEMPDIR", "TMP", "RUNNER_TEMP"]) {
      const tmpdir = process.env[key] || "";
      // HACK: There are too many bugs with cygwin directories.
      // We should probably run Windows tests in both cygwin and powershell.
      if (/cygwin|cygdrive/i.test(tmpdir) || !/^[a-z]/i.test(tmpdir)) {
        continue;
      }
      return normalizeWindows(tmpdir);
    }
    const appData = process.env["LOCALAPPDATA"];
    if (appData) {
      const appDataTemp = join(appData, "Temp");
      if (existsSync(appDataTemp)) {
        return appDataTemp;
      }
    }
  }

  if (isMacOS && existsSync("/tmp")) {
    return "/tmp";
  }

  return tmpdir();
}

/**
 * Gets the number of CPUs.
 * @returns {number}
 */
export function getCpus() {
  if ("navigator" in globalThis) {
    const { hardwareConcurrency: cpus } = navigator;
    if (typeof cpus === "number") {
      return cpus;
    }
  }

  return 1;
}

/**
 * Git utilities.
 */

/**
 * Gets the commit SHA.
 * @returns {string | undefined}
 */
export function getGitSha() {
  if (isBuildKite) {
    return process.env["BUILDKITE_COMMIT"];
  }

  if (isGithubAction) {
    return process.env["GITHUB_SHA"];
  }

  const { exitCode, stdout } = spawnSync("git", ["rev-parse", "HEAD"], {
    silent: true,
    throwOnError: false,
  });
  if (exitCode === 0) {
    return stdout.trim();
  }
}

/**
 * Gets the git branch.
 * @returns {string | undefined}
 */
export function getGitBranch() {
  if (isBuildKite) {
    return process.env["BUILDKITE_BRANCH"];
  }

  if (isGithubAction) {
    return process.env["GITHUB_REF_NAME"];
  }

  const { exitCode, stdout } = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    silent: true,
    throwOnError: false,
  });
  if (exitCode === 0) {
    return stdout.trim();
  }
}

/**
 * Gets the git repository URL.
 * @returns {string | undefined}
 */
export function getGitUrl() {
  if (isBuildKite) {
    return process.env["BUILDKITE_PULL_REQUEST_REPO"] || process.env["BUILDKITE_REPO"];
  }

  if (isGithubAction) {
    const baseUrl = process.env["GITHUB_SERVER_URL"];
    const repository = process.env["GITHUB_REPOSITORY"];
    if (baseUrl && repository) {
      return `${baseUrl}/${repository}`;
    }
  }

  const { exitCode, stdout } = spawnSync("git", ["remote", "get-url", "origin"], {
    silent: true,
    throwOnError: false,
  });
  if (exitCode === 0) {
    return stdout.trim();
  }
}

/**
 * Gets the git repository.
 * @returns {string | undefined}
 */
export function getGitRepository() {
  const url = getGitUrl();
  if (!url) {
    return;
  }
  const match = url.match(/^(?:https?:\/\/)?(?:[^@\/]+@)?([^\/:]+)(?::(\d+))?\/(.+)\.git$/);
  if (!match) {
    return;
  }
  const [, host, port, repository] = match;
  return repository;
}

/**
 * Gets whether the pull request is a fork.
 * @returns {boolean}
 */
export function isGitRepositoryFork() {
  if (isBuildKite) {
    return process.env["BUILDKITE_PULL_REQUEST_REPO"] !== process.env["BUILDKITE_REPO"];
  }

  if (isGithubAction) {
    // TODO: Figure out how to detect this.
  }

  return false;
}

/**
 * Gets the pull request number, if any.
 * @returns {number | undefined}
 */
export function getGitPullRequest() {
  if (isBuildKite) {
    const pullRequest = process.env["BUILDKITE_PULL_REQUEST"];
    if (pullRequest) {
      return parseInt(pullRequest);
    }
  }

  if (isGithubAction) {
    const isPullRequest = !!process.env["GITHUB_BASE_REF"];
    if (isPullRequest) {
      const gitRef = process.env["GITHUB_REF"];
      const match = gitRef.match(/^refs\/pull\/(\d+)\/merge$/);
      if (match) {
        const [, pullRequest] = match;
        return parseInt(pullRequest);
      }
    }
  }
}

/**
 * Gets whether the current branch is main on the main repository.
 * @returns {boolean}
 */
export function isGitMainBranch() {
  return getGitBranch() === "main" && !isGitRepositoryFork() && !getGitPullRequest();
}

/**
 * @typedef {Object} GitCloneOptions
 * @property {string} cwd
 * @property {string} [url]
 * @property {string} [commit]
 * @property {boolean} [recursive]
 */

/**
 * Clones a git repository.
 * @param {GitCloneOptions} options
 */
export async function gitClone(options) {
  const { cwd, url, recursive, commit } = options;
  const jobs = `${getCpus()}`;

  /**
   * @param {string} cwd
   * @returns {Promise<boolean>}
   */
  async function clone(cwd) {
    {
      const { exitCode } = await spawn("git", ["init"], { cwd, throwOnError: false });
      if (exitCode !== 0) {
        return false;
      }
    }
    {
      const { exitCode, stderr } = await spawn("git", ["remote", "add", "origin", url], { cwd, throwOnError: false });
      if (exitCode !== 0 && !stderr.includes("remote origin already exists")) {
        return false;
      }
    }
    {
      const args = ["fetch", "--progress", "--depth", "1", "--jobs", jobs, "origin", commit || "main"];
      if (recursive) {
        args.push("--recurse-submodules");
      }
      const { exitCode } = await spawn("git", args, {
        cwd,
        throwOnError: false,
      });
      if (exitCode !== 0) {
        return false;
      }
    }
    {
      const { exitCode } = await spawn("git", ["checkout", "FETCH_HEAD"], { cwd, throwOnError: false });
      if (exitCode !== 0) {
        return false;
      }
    }
    return true;
  }

  mkdir(cwd);
  let done = await clone(cwd);

  if (!done) {
    removeFile(cwd);
    done = await clone(options);
  }

  if (!done) {
    throw new Error(`Failed to clone repository: ${url}`);
  }
}

/**
 * @typedef {Object} GitCloneSubmoduleOptions
 * @property {string} [cwd]
 * @property {boolean} [force]
 * @property {boolean} [recursive]
 */

/**
 * Clones a git submodule.
 * @param {string} path
 * @param {GitCloneSubmoduleOptions} options
 */
export async function gitCloneSubmodule(path, options = {}) {
  const { cwd, recursive, force } = options;

  const jobs = `${getCpus()}`;
  const args = ["submodule", "update", "--init", "--progress", "--depth", "1", "--jobs", jobs];
  if (recursive) {
    args.push("--recursive");
  }
  if (force) {
    args.push("--force");
  }

  await spawn("git", [...args, "--", path], { cwd, throwOnError: false });
}

/**
 * Cleans a git repository.
 * @param {string} cwd
 */
export async function gitClean(cwd) {
  if (!exists(cwd)) {
    return;
  }

  if (isCI) {
    await gitReset(cwd);
  }

  await spawn("git", ["clean", "-fdx"], { cwd });
}

/**
 * Resets the git repository.
 * @param {string} cwd
 */
export async function gitReset(cwd) {
  if (!exists(cwd)) {
    return;
  }

  await spawn("git", ["reset", "--hard"], { cwd });
}

/**
 * Build properties.
 */

/**
 * Gets the label for the current build.
 * @returns {string | undefined}
 */
export function getBuildLabel() {
  if (isBuildKite) {
    return process.env["BUILDKITE_GROUP_LABEL"] || process.env["BUILDKITE_LABEL"];
  }

  if (isGithubAction) {
    return process.env["GITHUB_WORKFLOW"];
  }
}

/**
 * Gets the URL for the current build.
 * @returns {string | undefined}
 */
export function getBuildUrl() {
  if (isBuildKite) {
    const buildUrl = process.env["BUILDKITE_BUILD_URL"];
    const jobId = process.env["BUILDKITE_JOB_ID"];
    if (buildUrl) {
      return jobId ? `${buildUrl}#${jobId}` : buildUrl;
    }
  }

  if (isGithubAction) {
    const baseUrl = process.env["GITHUB_SERVER_URL"];
    const repository = process.env["GITHUB_REPOSITORY"];
    const runId = process.env["GITHUB_RUN_ID"];
    if (baseUrl && repository && runId) {
      return `${baseUrl}/${repository}/actions/runs/${runId}`;
    }
  }
}

/**
 * Gets the unique build ID.
 * @returns {string | undefined}
 */
export function getBuildId() {
  if (isBuildKite) {
    return process.env["BUILDKITE_BUILD_NUMBER"];
  }

  if (isGithubAction) {
    return process.env["GITHUB_RUN_ID"];
  }
}

/**
 * Gets the name of the current build step.
 * @returns {string | undefined}
 */
export function getBuildStep() {
  if (isBuildKite) {
    return process.env["BUILDKITE_STEP_KEY"];
  }
}

/**
 * Gets the number of retries for the current build.
 * @returns {number | undefined}
 */
export function getBuildRetries() {
  if (isBuildKite) {
    return parseInt(process.env["BUILDKITE_RETRY_COUNT"]);
  }

  if (isGithubAction) {
    return parseInt(process.env["GITHUB_RUN_ATTEMPT"]);
  }
}

/**
 * Gets a source URL for the given file and line, if any.
 * @param {string} file
 * @param {number} [line]
 * @returns {string | undefined}
 */
export function getSourceUrl(file, line) {
  const filePath = file.replace(/\\/g, "/");

  let url;
  if (pullRequest) {
    const fileMd5 = crypto.createHash("md5").update(filePath).digest("hex");
    url = `${baseUrl}/${repository}/pull/${pullRequest}/files#diff-${fileMd5}`;
    if (line !== undefined) {
      url += `L${line}`;
    }
  } else if (gitSha) {
    url = `${baseUrl}/${repository}/blob/${gitSha}/${filePath}`;
    if (line !== undefined) {
      url += `#L${line}`;
    }
  }

  return url;
}

/**
 * Gets the canary revision.
 * @returns {number}
 */
export function getCanaryRevision() {}

/**
 * Command utilities.
 */

/**
 * @typedef {Object} Command
 * @property {string} name
 * @property {string} [command]
 * @property {string[]} [aliases]
 * @property {string} [env]
 * @property {string} [minVersion]
 * @property {string} [exactVersion]
 * @property {boolean} [throwIfNotFound]
 */

/**
 * Asserts that a command is installed.
 * @param {Command} options
 * @returns {string}
 */
export function getCommand(options = {}) {
  const { name, command = name, aliases = [], minVersion, exactVersion, throwIfNotFound } = options;

  const option = getOption({ name });
  const label = option || command;
  if (isVerbose) {
    print(`Command:{reset} {cyan}{bold}${label}{reset}`);
  }

  const commands = option ? [option] : [command, ...aliases];
  const paths = which([...commands], {
    minVersion,
    exactVersion,
  });

  if (!paths.length && throwIfNotFound) {
    throw new Error(`Command not found: ${label}`);
  }

  return paths[0];
}

/**
 * @typedef {Object} WhichOptions
 * @property {string} [path]
 * @property {string} [minVersion]
 * @property {string} [exactVersion]
 */

/**
 * Returns a list of executable paths for the given command.
 * @param {string | string[]} command
 * @param {WhichOptions} options
 * @returns {string[]}
 */
export function which(command, options = {}) {
  const commands = Array.isArray(command) ? command : [command];
  const { path = process.env.PATH, minVersion, exactVersion } = options;

  if (isVerbose) {
    printCommand("which", commands, { env: { PATH: path } });
  }

  const paths = [];
  for (const command of commands) {
    if (isFile(command) && !paths.includes(command)) {
      paths.push(command);
    }
  }

  for (const binPath of path.split(isWindows ? ";" : ":")) {
    const names = isWindows ? ["exe", "cmd", "bat"].flatMap(ext => commands.map(cmd => `${cmd}.${ext}`)) : commands;
    for (const name of names) {
      const path = join(binPath, name);
      if (isFile(path) && !paths.includes(path)) {
        paths.push(path);
      }
    }
  }

  if (isVerbose) {
    for (const path of paths) {
      print(path);
    }
  }

  return paths.filter(
    path =>
      (!minVersion && !exactVersion) ||
      (minVersion && compareSemver(getVersion(path), minVersion) >= 0) ||
      (exactVersion && compareSemver(getVersion(path), exactVersion) === 0),
  );
}

/**
 * Gets the version of the given command.
 * @param {string} command
 * @returns {string | undefined}
 */
export function getVersion(command) {
  let args;
  if (/(?:zig|go)$/.test(command)) {
    args = ["version"];
  } else if (/(?:bun|bun\-[a-z]+)$/.test(command)) {
    args = ["--revision"];
  } else {
    args = ["--version"];
  }

  const { exitCode, stdout } = spawnSync(command, args, {
    silent: !isVerbose,
    throwOnError: false,
    env: {
      PATH: process.env.PATH,
      BUN_DEBUG_QUIET_LOGS: "1",
    },
  });

  if (exitCode === 0) {
    const version = parseSemver(stdout)?.join(".");
    if (isVerbose && version) {
      print(version);
    }
    return version;
  }
}

/**
 * File system.
 */

/**
 * Joins paths.
 * @param {...string | undefined} paths
 * @returns {string}
 */
export function join(...paths) {
  return path.join(...paths.filter(path => typeof path === "string"));
}

/**
 * Resolves paths.
 * @param {...string | undefined} paths
 * @returns {string}
 */
export function resolve(...paths) {
  return path.resolve(...paths.filter(path => typeof path === "string"));
}

/**
 * Gets the contents of a file.
 * @param {string} path
 * @param {Object} [options]
 * @param {boolean} [options.throwIfAbsent]
 * @returns {string | undefined}
 */
export function readFile(path, options) {
  try {
    return fs.readFileSync(path, "utf-8");
  } catch (cause) {
    const { code } = cause;
    if (code === "ENOENT" && options?.throwIfAbsent === false) {
      return;
    }
    throw cause;
  }
}

/**
 * Writes content to a file.
 * @param {string} path
 * @param {string} content
 * @param {Object} [options]
 * @param {boolean} [options.append]
 */
export function writeFile(path, content, options) {
  const parentPath = dirname(path);
  if (!isDirectory(parentPath)) {
    mkdir(parentPath);
  }

  if (options?.append) {
    fs.appendFileSync(path, content);
  } else {
    fs.writeFileSync(path, content);
  }
}

/**
 * Removes a file or directory.
 * @param {string} path
 */
export function removeFile(path) {
  if (isFile(path)) {
    printCommand("rm", ["-f", path]);
    fs.rmSync(path, { force: true });
  } else if (isDirectory(path)) {
    printCommand("rm", ["-rf", path]);
    fs.rmSync(path, { recursive: true, force: true });
  } else if (exists(path)) {
    throw new Error(`Not a file or directory: ${path}`);
  }
}

/**
 * Copies a file or directory to the target path.
 * @param {string} source
 * @param {string} target
 */
export function copyFile(source, target) {
  const parentPath = dirname(target);
  if (!isDirectory(parentPath)) {
    mkdir(parentPath);
  }

  if (isFile(source)) {
    printCommand("cp", [source, target]);
    fs.copyFileSync(source, target);
  } else if (isDirectory(source)) {
    printCommand("cp", ["-r", source, target]);
    fs.cpSync(source, target, { recursive: true, force: true });
  } else {
    throw new Error(`Not a file or directory: ${source}`);
  }
}

/**
 * Moves a file or directory to the target path.
 * @param {string} source
 * @param {string} target
 */
export function moveFile(source, target) {
  const parentPath = dirname(target);
  if (!isDirectory(parentPath)) {
    mkdir(parentPath);
  }

  if (isFile(source)) {
    printCommand("mv", [source, target]);
    fs.renameSync(source, target);
  } else if (isDirectory(source)) {
    printCommand("mv", ["-r", source, target]);
    fs.renameSync(source, target);
  } else {
    throw new Error(`Not a file or directory: ${source}`);
  }
}

/**
 * Lists the files in a directory.
 * @param {string} path
 * @param {Object} [options]
 * @param {boolean} [options.recursive]
 * @returns {string[]}
 */
export function listFiles(path, options = {}) {
  if (!isDirectory(path)) {
    return [];
  }

  const { recursive } = options;
  if (recursive) {
    printCommand("ls", ["-R", path]);
  } else {
    printCommand("ls", [path]);
  }

  return fs
    .readdirSync(path, { withFileTypes: true, recursive })
    .filter(entry => entry.isFile())
    .map(({ name }) => name);
}

/**
 * Creates a symlink to a file.
 * @param {string} source
 * @param {string} target
 */
export function symlinkFile(source, target) {
  if (exists(source) && fs.realpathSync(target) === source) {
    return;
  }

  if (exists(target)) {
    fs.unlinkSync(target);
  }

  printCommand("ln", ["-s", source, target]);
  fs.symlinkSync(source, target);
}

/**
 * Creates a symlink to a directory.
 * @param {string} source
 * @param {string} target
 */
export function symlinkDir(source, target) {
  if (exists(source) && fs.realpathSync(target) === source) {
    return;
  }

  if (exists(target)) {
    fs.unlinkSync(target);
  }

  printCommand("ln", ["-s", source, target]);
  fs.symlinkSync(source, target, "dir");
}

/**
 * Zips a directory into a zip file.
 * @param {string} path
 * @param {string} zipPath
 */
export async function zipFile(path, zipPath) {
  if (isWindows) {
    throw new Error("TODO");
  } else {
    await spawn("zip", ["-r", zipPath, path]);
  }

  if (!isFile(zipPath)) {
    throw new Error(`Zip file not found: ${zipPath}`);
  }
}

/**
 * Creates a directory.
 * @param {string} path
 * @param {Object} [options]
 * @param {boolean} [options.clean]
 */
export function mkdir(path, options) {
  if (isDirectory(path)) {
    if (!options?.clean) {
      return;
    }
    removeFile(path);
  }

  printCommand("mkdir", ["-p", path]);
  fs.mkdirSync(path, { recursive: true });
}

/**
 * Creates a temporary directory.
 * @param {string} [label]
 */
export function mkdirTemp(label = Math.random().toString(36).slice(2)) {
  const tmpPath = getTmpdir();
  const prefixPath = join(tmpPath, `${label}-`);
  printCommand("mktemp", ["-d", prefixPath]);
  fs.mkdtempSync(prefixPath, { recursive: true });
}

/**
 * Sets the permissions of a file or directory.
 * @param {string} path
 * @param {number} mode
 */
export function chmod(path, mode) {
  printCommand("chmod", [`${mode}`, path]);
  fs.chmodSync(path, mode);
}

/**
 * Gets whether the given path exists and is a file.
 * @param {string} path
 * @returns {boolean}
 */
export function isFile(path) {
  if (!exists(path)) {
    return false;
  }

  try {
    const stat = fs.statSync(path);
    return stat.isFile();
  } catch (cause) {
    emitWarning(cause);
  }

  return false;
}

/**
 * Gets whether the given path exists and is a directory.
 * @param {string} path
 * @returns {boolean}
 */
export function isDirectory(path) {
  if (!exists(path)) {
    return false;
  }

  try {
    const stat = fs.statSync(path);
    return stat.isDirectory();
  } catch (cause) {
    emitWarning(cause);
  }

  return false;
}

/**
 * Gets whether a path exists.
 * @param {string} path
 * @returns {boolean}
 */
export function exists(path) {
  return fs.existsSync(path);
}

/**
 * Subprocess.
 */

/**
 * @typedef {Object} SpawnOptions
 * @property {string} [cwd]
 * @property {string} [env]
 * @property {string} [encoding]
 * @property {number} [timeout]
 * @property {boolean} [silent]
 * @property {string} [input]
 * @property {boolean} [throwOnError]
 */

/**
 * @typedef {Object} SpawnResult
 * @property {number | null} exitCode
 * @property {number | null} signalCode
 * @property {Error} [spawnError]
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * Spawns a command.
 * @param {string} command
 * @param {string[]} [args]
 * @param {SpawnOptions} [options]
 * @returns {Promise<SpawnResult>}
 */
export async function spawn(command, args, options = {}) {
  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  let signalCode = null;
  let spawnError = null;
  const done = new Promise((resolve, reject) => {
    let subprocess;
    try {
      subprocess = cp.spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        ...options,
      });
      subprocess.on("error", reject);
      subprocess.on("exit", (status, signal) => {
        exitCode = status;
        signalCode = signal;
        resolve();
      });
      subprocess.stdout?.on("data", chunk => {
        if (!options.silent && !isQuiet) {
          process.stdout.write(chunk);
        }
        stdout += chunk.toString("utf-8");
      });
      subprocess.stderr?.on("data", chunk => {
        if (!options.silent && !isQuiet) {
          process.stderr.write(chunk);
        }
        stderr += chunk.toString("utf-8");
      });
    } catch (cause) {
      reject(cause);
    }
  });
  printCommand(command, args, options);
  try {
    await done;
  } catch (cause) {
    spawnError = cause;
  }
  const label = `${command} ${args.includes(" ") ? `"${args}"` : args}`;
  const result = { exitCode, signalCode, spawnError, stdout, stderr };
  parseMessages(result, options);
  if (exitCode === 0) {
    return result;
  }
  if (options.throwOnError !== false) {
    const cause = spawnError || new Error(`Process exited: ${signalCode || `code ${exitCode}`}`);
    throw new Error(`Command failed: ${label}`, { cause });
  }
  return result;
}

/**
 * Spawns a command, synchronously.
 * @param {string} command
 * @param {string[]} [args]
 * @param {SpawnOptions} [options]
 * @returns {SpawnResult}
 */
export function spawnSync(command, args, options = {}) {
  printCommand(command, args, options);
  try {
    const { error, status, signal, stdout, stderr } = cp.spawnSync(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      env: process.env,
      ...options,
    });
    if (error) {
      throw error;
    }
    if (options.throwOnError !== false && (signal || status !== 0)) {
      const reason = signal || `code ${status}`;
      const cause = stderr || stdout;
      throw new Error(`Process exited: ${reason}`, { cause });
    }
    return { exitCode: status, signalCode: signal, stdout, stderr };
  } catch (cause) {
    if (options.throwOnError === false) {
      return { exitCode: -1, signalCode: null, spawnError: cause, stdout: "", stderr: "" };
    }
    const description = `${command} ${args.join(" ")}`;
    throw new Error(`Command failed: ${description}`, { cause });
  }
}

export function printCommand(command, args = [], options = {}) {
  if (!isVerbose || options.silent) {
    return;
  }
  const entries = Object.entries(options.env || {});
  for (const [key, value] of entries) {
    print(`{magenta}{bold}export {reset}{dim}${key}=${value}{reset}`);
  }
  const cwd = resolve(options.cwd || ".");
  if (cwd !== process.cwd()) {
    print(`{yellow}{bold}cd {reset}{dim}${cwd}{reset}`);
  }
  print(
    `{cyan}{bold}$ {reset}{dim}${command} ${args.map(arg => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ")}{reset}`,
  );
}

/**
 * @type {string | undefined}
 */
let ntStatus;

/**
 * Gets the exit code for the given Windows exit code.
 * @param {number} exitCode
 * @returns {string}
 */
export function getWindowsExitCode(exitCode) {
  if (ntStatus === undefined) {
    const ntStatusPath = "C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.22621.0\\shared\\ntstatus.h";
    try {
      ntStatus = readFileSync(ntStatusPath, "utf-8");
    } catch (error) {
      console.warn(error);
      ntStatus = "";
    }
  }

  const match = ntStatus.match(new RegExp(`(STATUS_\\w+).*0x${exitCode?.toString(16)}`, "i"));
  return match?.[1];
}

/**
 * Console utilities.
 */

const ansiColors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  pink: "\x1b[37m",
};

/**
 * Formats a string or value with pretty colors.
 * @param {string} value
 * @returns {string}
 */
export function format(value) {
  let string;
  if (value instanceof Error) {
    const { message, stack, cause } = value;
    const stackTrace = stack.split("\n").slice(1).join("\n");
    string = `{reset}${message}\n{dim}${stackTrace}{reset}`;
    if (cause) {
      string += `\n{yellow}{bold}cause{reset}: ${format(cause)}`;
    }
  } else if (typeof value === "string") {
    string = value;
  } else {
    string = inspect(value);
  }
  return string.replace(/{(\w+)}/g, (_, color) => ansiColors[color] || "");
}

/**
 * Prints a message to console.
 * @param {...any} args
 */
export function print(...args) {
  console.log(...args.map(arg => format(arg)));
}

/**
 * Prints a warning message to console.
 * @param {...any} args
 */
export function warn(...args) {
  console.warn(format("{yellow}{bold}warning{reset}:"), ...args.map(arg => format(arg)));
}

export function emitWarning(message) {
  warn(message);
}

/**
 * Prints an error message to console and exits the process.
 * @param {...any} args
 * @returns {never}
 */
export function error(...args) {
  console.error(format("{red}{bold}error{reset}:"), ...args.map(arg => format(arg)));
  process.exit(1);
}

/**
 * @param  {...any} args
 * @returns {never}
 */
export function fatalError(...args) {
  error(...args);
}

/**
 * CLI options.
 */

/**
 * @typedef {Object} Option
 * @property {string} name
 * @property {string} [description]
 * @property {"string" | "boolean" | "number"} [type]
 * @property {string | string[]} [flag]
 * @property {string | string[]} [env]
 * @property {string | Function} [defaultValue]
 * @property {Function} [parse]
 */

/**
 * Parses an option from the command line or environment.
 * @param {Option} option
 */
export function getOption(option) {
  const { name, type, flag = name, env = name, defaultValue, parse } = option;
  const args = process.argv.slice(2);

  /**
   * @param {string} name
   * @returns {string | undefined}
   */
  function parseFlag(name) {
    const label = name.length === 1 ? `-${name}` : `--${name}`;
    const hasValue = type !== "boolean";
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === label) {
        if (!hasValue) {
          return "true";
        }
        if (i + 1 >= args.length) {
          throw new Error(`Option requires a value: ${arg}`);
        }
        const value = args[i + 1];
        if (value.startsWith("-")) {
          throw new Error(`Option requires a value, but received a flag instead: ${arg} ${value}`);
        }
        return value;
      }
      const prefix = `${label}=`;
      if (arg.startsWith(prefix)) {
        return arg.slice(prefix.length);
      }
    }
  }

  let flagValue;
  if (typeof flag === "string") {
    flagValue = parseFlag(flag);
  } else if (Array.isArray(flag)) {
    for (const name of flag) {
      flagValue = parseFlag(name);
      if (flagValue) {
        break;
      }
    }
  }

  const flagName = Array.isArray(flag) ? flag[0] : flag;
  if (flagValue && isVerbose) {
    print(`Option: {yellow}{bold}--${flagName}{reset} {dim}${flagValue}{reset}`);
  }

  /**
   * @param {string} name
   * @returns {string | undefined}
   */
  function parseEnv(name) {
    const value = process.env[name] || process.env[`${name.toUpperCase()}`] || process.env[`${name.toLowerCase()}`];
    if (value) {
      return value;
    }
  }

  let envValue;
  if (typeof env === "string") {
    envValue = parseEnv(env);
  } else if (Array.isArray(env)) {
    for (const name of env) {
      envValue = parseEnv(name);
      if (envValue) {
        break;
      }
    }
  }

  const envName = Array.isArray(env) ? env[0] : env;
  if (envValue && isVerbose) {
    print(`Option: {magenta}{bold}$${envName}{reset} {dim}${envValue}{reset}`);
  }

  const label = flagValue ? `--${flagName}` : `$${envName}`;
  if (flagValue && envValue && flagValue !== envValue) {
    throw new Error(`Option has conflicting values: --${flagName} ${flagValue} and $${envName}=${envValue}`);
  }

  let value = flagValue || envValue;
  if (!value) {
    if (typeof defaultValue === "function") {
      value = defaultValue();
    } else {
      value = defaultValue;
    }
  }

  if (typeof value === "undefined") {
    return;
  } else if (typeof value !== "string") {
    value = `${value}`;
  }

  let fn;
  if (typeof parse === "function") {
    fn = parse;
  } else if (type === "boolean") {
    fn = parseBoolean;
  } else if (type === "number") {
    fn = parseNumber;
  }

  if (!fn) {
    return value;
  }

  try {
    return fn(value);
  } catch (cause) {
    throw new Error(`Option is invalid: ${label} ${value}`, { cause });
  }
}

/**
 * Parsing utilities.
 */

/**
 * Parses a string into a target name.
 * @param {string} target
 * @returns {string}
 */
export function parseTarget(target) {
  const match = /^(?:bun-)?(?<os>[a-z]+)-(?<arch>[a-z0-9]+)(?<suffix>-baseline)?$/i.exec(target);
  if (!match) {
    throw new Error(`Invalid target: ${target}`);
  }

  try {
    const os = parseOs(match.groups.os);
    const arch = parseArch(match.groups.arch);
    const suffix = match.groups.suffix || "";

    if (suffix === "-baseline" && arch !== "x64") {
      throw new Error(`Baseline is not supported on architecture: ${arch}`);
    } else if (os === "windows" && arch !== "x64") {
      throw new Error(`Windows is not supported on architecture: ${arch}`);
    }

    return `bun-${os}-${arch}${suffix}`;
  } catch (cause) {
    throw new Error(`Invalid target: ${target}`, { cause });
  }
}

/**
 * Parses a string into an operating system.
 * @param {string} os
 * @returns {"windows" | "linux" | "darwin"}
 */
export function parseOs(os) {
  if (/darwin|mac|apple/i.test(os)) {
    return "darwin";
  }
  if (/linux/i.test(os)) {
    return "linux";
  }
  if (/windows|win32|cygwin|mingw|msys/i.test(os)) {
    return "windows";
  }
  throw new Error(`Unsupported operating system: ${os}`);
}

/**
 * Parses a string into an architecture.
 * @param {string} arch
 * @returns {"x64" | "aarch64"}
 */
export function parseArch(arch) {
  if (/aarch64|arm64/i.test(arch)) {
    return "aarch64";
  }
  if (/x64|x86_64|amd64/i.test(arch)) {
    return "x64";
  }
  throw new Error(`Unsupported architecture: ${arch}`);
}

/**
 * Parses a string into a boolean.
 * @param {string} string
 * @returns {boolean}
 */
export function parseBoolean(string) {
  if (/^(?:true|1|on|yes)$/i.test(string)) {
    return true;
  }
  if (/^(?:false|0|off|no)$/i.test(string)) {
    return false;
  }
  throw new Error(`Invalid value: expected 'true' or 'false', received '${string}'`);
}

/**
 * Parses a string into a number.
 * @param {string} string
 * @returns {number}
 */
export function parseNumber(string) {
  const number = parseFloat(string);
  if (!Number.isNaN(number)) {
    return number;
  }
  throw new Error(`Invalid value: expected a number, received '${string}'`);
}

/**
 * Parses a string into a millisecond duration.
 * @param {string} string
 * @returns {number | undefined}
 */
export function parseDuration(duration) {
  const match = /(\d+\.\d+)(m?s)/.exec(duration);
  if (!match) {
    return undefined;
  }
  const [, value, unit] = match;
  return parseFloat(value) * (unit === "ms" ? 1 : 1000);
}

/**
 * Parses a string into a semantic version.
 * @param {string} version
 * @returns {number[] | undefined}
 */
export function parseSemver(version) {
  const match = `${version}`.match(/(\d+)\.?(\d+)?\.?(\d+)?/);
  if (!match) {
    return;
  }
  return match
    .slice(1, 4)
    .map(n => parseInt(n))
    .filter(n => isFinite(n));
}

/**
 * String formatting.
 */

/**
 * Formats epoch milliseconds into a human-readable duration.
 * @param {number} epoch
 */
export function formatDuration(epoch) {
  if (isNaN(epoch) || epoch <= 0) {
    return "0s";
  }
  const seconds = epoch / 1000;
  if (seconds < 1) {
    return `${seconds.toFixed(2)}ms`;
  }
  const minutes = seconds / 60;
  if (minutes < 1) {
    return `${seconds.toFixed(2)}s`;
  }
  const hours = minutes / 60;
  if (hours < 1) {
    return `${minutes.toFixed(2)}m`;
  }
  return `${hours.toFixed(2)}h`;
}

/**
 * Strips ANSI escape codes from a string.
 * @param {string} string
 * @returns {string}
 */
export function stripAnsi(string) {
  return string.replace(/\u001b\[\d+m/g, "");
}

/**
 * Escapes a string for use in GitHub Actions.
 * @param {string} string
 * @returns {string}
 */
export function escapeGitHubAction(string) {
  return string.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Unescapes a string from GitHub Actions.
 * @param {string} string
 * @returns {string}
 */
export function unescapeGitHubAction(string) {
  return string.replace(/%25/g, "%").replace(/%0D/g, "\r").replace(/%0A/g, "\n");
}

/**
 * Escapes a string for use in HTML.
 * @param {string} string
 * @returns {string}
 */
export function escapeHtml(string) {
  return string
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/`/g, "&#96;");
}

/**
 * Escapes a string for use in a markdown code block.
 * @param {string} string
 * @returns {string}
 */
export function escapeCodeBlock(string) {
  return string.replace(/`/g, "\\`");
}

/**
 * Compares two semantic versions, returning -1 if a < b, 0 if a == b, and 1 if a > b.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  const a0 = parseSemver(a);
  const b0 = parseSemver(b);
  if (!a0 || !b0) {
    return 0;
  }
  for (let i = 0; i < 3; i++) {
    const a1 = a0[i] || 0;
    const b1 = b0[i] || 0;
    if (a1 !== b1) {
      return a1 - b1;
    }
  }
  return 0;
}

/**
 * Miscellaneous utilities.
 */

/**
 * Adds a path to the PATH environment variable.
 * @param {string} binPath
 */
export function addToPath(binPath) {
  const delim = isWindows ? ";" : ":";
  const path = process.env["PATH"];

  if (!path || path.includes(binPath)) {
    return;
  }

  print(`Added {dim}${binPath}{reset} to PATH`);
  process.env["PATH"] = `${binPath}${delim}${path}`;

  const shell = process.env["SHELL"];
  if (!isFile(shell)) {
    return;
  }

  if (isWindows) {
    spawnSync(shell, ["-c", `set PATH=${binPath};%PATH%`], { throwOnError: false });
  } else {
    spawnSync(shell, ["-c", `export PATH="${binPath}:$PATH"`], { throwOnError: false });
  }
}

/**
 * Runs a task with a label.
 * @param {string} label
 * @param {Function} fn
 */
export async function runTask(label, fn) {
  if (isGithubAction) {
    print(`::group::${stripAnsi(format(label))}`);
  } else if (isBuildKite) {
    print(`--- ${label}`);
  } else {
    print(label);
  }

  const start = Date.now();
  try {
    return await fn();
  } finally {
    const duration = Date.now() - start;
    if (duration > 10) {
      print(`Took ${formatDuration(duration)}`);
    }

    if (isGithubAction) {
      print("::endgroup::");
    }
  }
}

/**
 * Gets whether an error is busy and needs a backoff.
 * @param {unknown} error
 * @returns {boolean}
 */
export function isBusy(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const { code } = error;
  return code === "EBUSY" || code === "ETIMEDOUT" || code === "UNKNOWN";
}

/**
 * @param {number} retries
 */
export async function backOff(retries = 0) {
  await new Promise(resolve => setTimeout(resolve, (retries + 1) * 1000));
}

/**
 * Buildkite utilities.
 */

/**
 * Uploads an artifact to buildkite.
 * @param {string} path
 * @param {string} [cwd]
 */
export async function buildkiteUploadArtifact(path, cwd = dirname(path)) {
  const filename = relative(cwd, path);
  const args = ["artifact", "upload", filename];
  if (isDebug) {
    args.push("--log-level", "debug");
  }
  await spawn("buildkite-agent", args, { cwd });
}

/**
 * @typedef {Object} BuildkiteDownloadArtifactOptions
 * @property {string} step
 * @property {string} [filename]
 * @property {string} [cwd]
 * @property {number} [retries]
 */

/**
 * Downloads an artifact from buildkite.
 * @param {BuildkiteDownloadArtifactOptions} options
 */
export async function buildkiteDownloadArtifact(options) {
  const { step, filename, cwd, retries = 5 } = options;

  const args = ["artifact", "download", "--step", step, filename || "**"];
  if (isVerbose || !retries) {
    args.push("--log-level", "debug");
  }

  while (retries--) {
    try {
      await spawn("buildkite-agent", args, { cwd });
    } catch (cause) {
      if (retries === 0) {
        throw cause;
      }
      emitWarning(cause);
      if (isBusy(cause)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
    }
  }
}

/**
 * @typedef {Object} Message
 * @property {string} title
 * @property {string} content
 * @property {string} [url]
 * @property {string} [label]
 * @property {string} [file]
 * @property {number} [line]
 * @property {number} [column]
 * @property {"error" | "warning" | "notice"} [type]
 */

/**
 * Prints a message to console.
 * @param {Message} message
 */
export function emitMessage(message) {
  const { content, preview, file, line, column } = message;

  if (isGithubAction) {
    // TODO
  } else if (isBuildKite) {
    // TODO
  } else {
    console.log(message);
  }
}

/**
 * Parses through stdout or stderr to find errors.
 * @param {SpawnResult} result
 * @param {SpawnOptions} [options]
 * @returns {Message[]}
 */
function parseMessages(result, options = {}) {
  const { stdout, stderr } = result;
  const { cwd } = options;

  let i = 0;
  const lines = [...stdout.split("\n"), ...stderr.split("\n")];

  /**
   * @typedef {Object} Line
   * @property {number} i
   * @property {string} originalLine
   * @property {string} line
   */

  function done() {
    return i >= lines.length;
  }

  /**
   * @returns {Line}
   */
  function peek() {
    if (done()) {
      throw new Error(`Unexpected end of output [${i}/${lines.length}]`);
    }
    const originalLine = lines[i];
    const line = stripAnsi(originalLine);
    return { originalLine, line };
  }

  /**
   * @returns {Line}
   */
  function read() {
    const line = peek();
    i++;
    return line;
  }

  /**
   * @param {(line: Line) => boolean} fn
   * @returns {string[]}
   */
  function readUntil(fn) {
    const lines = [];
    while (!done()) {
      const line = read();
      const { originalLine } = line;
      lines.push(originalLine);
      if (fn(line)) {
        return lines;
      }
    }
    return lines;
  }

  /**
   * @param {number} n
   * @returns {string[]}
   */
  function readNext(n) {
    return readUntil(({ i }) => i >= n);
  }

  const pwd = process.cwd();

  /**
   * @param {string | undefined} filename
   * @returns {string | undefined}
   */
  function parseFile(filename) {
    if (!filename) {
      return;
    }
    const parts = normalize(relative(pwd, filename)).replace(/\\/g, "/").split("/");
    for (let i = 0; j < parts.length; i++) {
      const path = join(...parts.slice(0, i ? -i : undefined));
      if (isFile(path)) {
        return relative(pwd, path);
      }
    }
    return parts.join("/");
  }

  /**
   * @returns {Message | undefined}
   */
  function parseNinjaError() {
    const { line } = peek();

    const match = /^FAILED: (?:\S+ )?(\S+)?/.exec(line);
    if (!match) {
      return;
    }

    const [, filename] = match;
    const file = parseFile(filename);
    const [title, _, ...errors] = readUntil(({ line }) =>
      /^(?:\d+ errors? generated)|(?:ninja: build stopped)/.test(line),
    );

    return {
      file,
      title: file,
      content: [title, ...errors].join("\n"),
      type: "error",
      label: "build error",
    };
  }

  /**
   * @returns {Message | undefined}
   */
  function parseZigError() {
    const { line } = peek();

    const match = /^(.*\.zig):(\d+):(\d+): (error|warning):/.exec(line);
    if (!match) {
      return;
    }

    const [, filename, ln, col, type] = match;
    const file = parseFile(filename);
    const lines = readUntil(({ line }) => !line);

    return {
      file,
      line: parseInt(ln),
      column: parseInt(col),
      title: file,
      content: lines.join("\n"),
      type: "error",
      label: "zig error",
    };
  }

  /**
   * @type {Message[]}
   */
  const messages = [];

  while (!done()) {
    const message = parseZigError() || parseNinjaError();
    if (message) {
      messages.push(message);
    }
    i++;
  }

  return messages;
}
