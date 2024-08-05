#!/usr/bin/env node

/**
 * This script builds bun and its dependencies.
 */

import { basename, dirname } from "node:path";
import {
  emitWarning,
  fatalError,
  isCI,
  isVerbose,
  getCommand,
  getOption,
  join,
  resolve,
  exists,
  isDirectory,
  isFile,
  readFile,
  writeFile,
  removeFile,
  copyFile,
  listFiles,
  spawn,
  gitClone,
  parseOs,
  parseArch,
  getCpus,
  gitCloneSubmodule,
  runTask,
  print,
  compareSemver,
  isBuildKite,
  buildkiteUploadArtifact,
  getGitSha,
  isGithubAction,
  isWindows,
  isMacOS,
  spawnSync,
  addToPath,
  isLinux,
  getBuildId,
  getBuildStep,
  isGitMainBranch,
  symlinkDir,
  getVersion,
  chmod,
  mkdir,
  zipFile,
  symlinkFile,
} from "./util.mjs";

/**
 * @typedef {Object} BuildOptions
 * @property {string} cwd
 * @property {string} buildPath
 * @property {"linux" | "darwin" | "windows"} os
 * @property {"x64" | "aarch64"} arch
 * @property {boolean} [baseline]
 * @property {string} [target]
 * @property {boolean} [release]
 * @property {boolean} [debug]
 * @property {boolean} [lto]
 * @property {boolean} [pic]
 * @property {boolean} [valgrind]
 * @property {string} [osxVersion]
 * @property {string} [llvmVersion]
 * @property {string} [cc]
 * @property {string} [cxx]
 * @property {string} [ar]
 * @property {string} [ld]
 * @property {string} [ranlib]
 * @property {string} [ccache]
 * @property {string} [clean]
 * @property {string} [artifact]
 * @property {string} [cachePath]
 * @property {"read-write" | "read" | "write" | "none"} [cacheStrategy]
 */

async function main() {
  process.on("uncaughtException", err => fatalError(err));
  process.on("unhandledRejection", err => fatalError(err));
  process.on("warning", err => emitWarning(err));

  const customTarget = getOption({
    name: "target",
    description: "The target to build (e.g. bun-darwin-aarch64, bun-windows-x64-baseline)",
    defaultValue: () => {
      if (isCI) {
        return getBuildStep();
      }
    },
  });

  const machineOs = parseOs(process.platform);
  const os = getOption({
    name: "os",
    description: "The target operating system (e.g. linux, darwin, windows)",
    parse: parseOs,
    defaultValue: customTarget || machineOs,
  });

  const machineArch = parseArch(process.arch);
  const arch = getOption({
    name: "arch",
    description: "The target architecture (e.g. x64, aarch64)",
    parse: parseArch,
    defaultValue: customTarget || machineArch,
  });

  const crossCompile = getOption({
    name: "cross-compile",
    description: "If the target is allowed to be cross-compiled (Zig only)",
    type: "boolean",
  });

  const baseline = getOption({
    name: "baseline",
    description: "If the target should be built for baseline",
    type: "boolean",
    defaultValue: customTarget?.includes("-baseline"),
  });

  const target = baseline ? `bun-${os}-${arch}-baseline` : `bun-${os}-${arch}`;

  if (!crossCompile && (machineOs !== os || machineArch !== arch)) {
    throw new Error(`Cross-compilation is not enabled, use --cross-compile if you want to compile: ${target}`);
  }

  const debug = getOption({
    name: "debug",
    description: "If the target should be built in debug mode",
    type: "boolean",
  });

  const debugSymbols = getOption({
    name: "debug-symbols",
    description: "If debug symbols should be generated",
    type: "boolean",
  });

  const lto = getOption({
    name: "lto",
    description: "If the target should be built with link-time optimization (LTO)",
    type: "boolean",
    defaultValue: !debug && os === "linux",
  });

  const valgrind = getOption({
    name: "valgrind",
    description: "If mimalloc should be built with valgrind",
    type: "boolean",
  });

  if (valgrind && os !== "linux") {
    throw new Error(`Valgrind is not supported on target: ${os}-${arch}`);
  }

  const assertions = getOption({
    name: "assertions",
    description: "If debug assertions should be enabled",
    type: "boolean",
    defaultValue: debug || !isCI || !isGitMainBranch(),
  });

  const canary = getOption({
    name: "canary",
    description: "If the build is a canary build, the canary revision",
    type: "number",
    defaultValue: () => {
      if (isCI && isGitMainBranch()) {
        return 0;
      }
      return 1;
    },
  });

  const buildId = getOption({
    name: "build-id",
    description: "The unique build ID (e.g. build number from CI)",
    type: "string",
    defaultValue: () => {
      if (isCI) {
        return getBuildId();
      }
    },
  });

  const clean = getOption({
    name: "clean",
    description: "If directories should be cleaned before building",
    type: "boolean",
    defaultValue: isCI,
  });

  const osxVersion = getOption({
    name: "min-macos-version",
    description: "The minimum version of macOS to target",
    defaultValue: () => {
      if (isCI && os === "darwin") {
        return "13.0";
      }
    },
  });

  const llvmVersion = getOption({
    name: "llvm-version",
    description: "The LLVM version to use",
    defaultValue: isLinux ? "16.0.6" : "18.1.8",
  });

  const skipLlvmVersion = getOption({
    name: "skip-llvm-version",
    description: "If the LLVM version should be ignored (do not check LLVM version of CC, CXX, AR, etc)",
    type: "boolean",
  });

  const exactLlvmVersion = skipLlvmVersion ? undefined : llvmVersion;
  const majorLlvmVersion = llvmVersion.split(".")[0];

  const llvmPath = getLlvmPath(exactLlvmVersion);
  if (llvmPath) {
    addToPath(llvmPath);
  }

  const cc = getCommand({
    name: "cc",
    description: "The C compiler to use",
    command: os === "windows" ? "clang-cl" : "clang",
    aliases: os === "windows" ? [] : [`clang-${majorLlvmVersion}`, "cc"],
    exactVersion: exactLlvmVersion,
    throwIfNotFound: !skipLlvmVersion,
  });

  const cxx = getCommand({
    name: "cxx",
    description: "The C++ compiler to use",
    command: os === "windows" ? "clang-cl" : "clang++",
    aliases: os === "windows" ? [] : [`clang++-${majorLlvmVersion}`, "c++"],
    exactVersion: exactLlvmVersion,
    throwIfNotFound: !skipLlvmVersion,
  });

  const ar = getCommand({
    name: "ar",
    description: "The archiver to use",
    command: os === "windows" ? "llvm-lib" : "llvm-ar",
    aliases: os === "windows" ? [] : [`llvm-ar-${majorLlvmVersion}`],
    exactVersion: exactLlvmVersion,
    throwIfNotFound: !skipLlvmVersion,
  });

  const ranlib = getCommand({
    name: "ranlib",
    description: "The ranlib to use",
    command: "llvm-ranlib",
    aliases: [`llvm-ranlib-${llvmVersion}`],
    exactVersion: exactLlvmVersion,
    throwIfNotFound: os !== "windows" && !skipLlvmVersion,
  });

  const ccache = getCommand({
    name: "ccache",
    description: "The ccache to use",
    aliases: ["sccache"],
    throwIfNotFound: isCI,
  });

  const jobs = getOption({
    name: "jobs",
    description: "The number of parallel jobs to use",
    env: ["NUMBER_OF_PROCESSORS", "CPUS", "JOBS"],
    type: "number",
    defaultValue: getCpus,
  });

  const cwd = getOption({
    name: "cwd",
    description: "The current working directory",
    parse: resolve,
    defaultValue: process.cwd(),
  });

  const buildPath = getOption({
    name: "build-path",
    description: "The build directory",
    parse: resolve,
    defaultValue: join(cwd, "target", debug ? "debug" : "release", target),
  });

  if (!isCI && machineOs === os && machineArch === arch) {
    symlinkDir(buildPath, join(cwd, "build"));
  }

  const cachePath = getOption({
    name: "cache-path",
    description: "The path to use for build caching",
    parse: resolve,
    defaultValue: () => {
      if (isCI) {
        const homePath = process.env["HOME"];
        if (homePath) {
          return join(homePath, ".cache", debug ? "debug" : "release", target);
        }
      }
      return join(cwd, ".cache");
    },
  });

  const noCache = getOption({
    name: "no-cache",
    description: "If the build caching should be disabled",
    type: "boolean",
  });

  const cacheStrategy = getOption({
    name: "cache-strategy",
    description: "The strategy for build caching (e.g. read-write, read, write, none)",
    defaultValue: noCache ? "none" : "read-write",
  });

  const dump = getOption({
    name: "dump",
    aliases: ["print"],
    description: "Dump the build options and exit",
    type: "boolean",
  });

  /**
   * @type {BuildOptions}
   */
  const options = {
    os,
    arch,
    baseline,
    target,
    lto,
    debug,
    debugSymbols,
    valgrind,
    assertions,
    canary,
    buildId,
    osxVersion,
    llvmVersion,
    cc,
    cxx,
    ar,
    ranlib,
    ccache,
    clean,
    jobs,
    cwd,
    buildPath,
    cachePath,
    cacheStrategy,
    dump,
  };

  const inheritEnv = getOption({
    name: "inherit-env",
    description: "If environment variables from the host should be inherited",
    type: "boolean",
  });

  const buildEnv = getBuildEnv(options);

  for (const key of Object.keys(buildEnv)) {
    const buildValue = buildEnv[key];
    const hostValue = process.env[key];

    if (hostValue && hostValue !== buildValue) {
      emitWarning(`Environment variable has conflicting values: ${key}\n  Host: ${hostValue}\n  Build: ${buildValue}`);
    }

    // If an environment variable is set in CI, it should be used.
    // Otherwise, it should use the build environment.
    if (isCI) {
      process.env[key] ||= buildValue;
    } else {
      process.env[key] = buildValue;
    }
  }

  for (const key of Object.keys(process.env)) {
    if (!inheritEnv && !(key in buildEnv) && !isSystemEnv(key)) {
      delete process.env[key];
    }
  }

  const noColor = getOption({
    name: "no-color",
    description: "If the output should be colorless",
    type: "boolean",
  });

  process.env["FORCE_COLOR"] = noColor ? "0" : "1";
  process.env["CLICOLOR_FORCE"] = "1";

  const args = process.argv.slice(2).filter(arg => !arg.startsWith("-"));
  await build(options, ...args);
}

/**
 * @param {BuildOptions} options
 * @param  {...string} args
 */
export async function build(options, ...args) {
  const artifacts = getArtifacts(options);
  /**
   * @type {Artifact[]}
   */
  const builds = [];

  /**
   * @param {string} query
   */
  function addBuild(query) {
    const matches = artifacts.filter(({ name, aliases }) => name === query || aliases?.includes(query));
    if (!matches.length) {
      throw new Error(`Unknown artifact: ${query}`);
    }

    for (const artifact of matches) {
      const { dependencies } = artifact;

      if (builds.some(({ name }) => name === artifact.name)) {
        return;
      }

      dependencies?.forEach(dependency => addBuild(dependency));
      builds.push(artifact);
    }
  }

  for (const arg of args) {
    const buildCount = builds.length;

    for (const artifact of artifacts) {
      const { name, aliases } = artifact;
      if (arg === name || aliases?.includes(arg)) {
        addBuild(name);
      }
    }

    if (builds.length === buildCount) {
      throw new Error(`Unknown artifact: ${arg}`);
    }
  }

  if (!builds.length) {
    addBuild("bun");
  }

  const { buildPath: baseBuildPath, clean, dump } = options;
  if (dump || isCI) {
    await runTask("Builds", () => console.log(builds.map(({ name }) => name)));
    await runTask("Options", () => console.log(options));
    await runTask("Environment", () => console.log(process.env));
  }
  if (dump) {
    return;
  }

  for (const { name, cwd, build, artifacts = [], artifactsPath } of builds) {
    const buildPath = join(baseBuildPath, name);
    const buildOptions = {
      ...options,
      cwd: cwd || options.cwd,
      buildPath,
      artifact: name.startsWith("bun") ? "bun" : name,
    };

    /**
     * @param {string} path
     */
    async function uploadArtifact(path) {
      const artifactPath = join(buildPath, path);
      if (!isFile(artifactPath)) {
        throw new Error(`No artifact found: ${path}`);
      }

      if (artifactsPath) {
        copyFile(artifactPath, join(artifactsPath, basename(path)));
      }

      if (isBuildKite) {
        await buildkiteUploadArtifact(artifactPath);
      }
    }

    async function uploadArtifacts() {
      await Promise.all(artifacts.map(uploadArtifact));
    }

    const isDependency = artifactsPath?.includes("deps");

    if (isDependency && artifacts.length && artifacts.every(name => isFile(join(buildPath, name)))) {
      await runTask(`Cached ${name}`, uploadArtifacts);
      continue;
    }

    await runTask(`Building ${name}`, async () => {
      if (isDependency) {
        await gitCloneSubmodule(cwd, { force: isCI });
      }

      if (clean) {
        removeFile(buildPath);
        for (const artifact of artifacts) {
          removeFile(join(buildPath, artifact));
        }
      }

      await build(buildOptions);
      await uploadArtifacts();
    });
  }
}

/**
 * Build bun.
 */

/**
 * @param {BuildOptions} options
 */
async function bunZigBuild(options) {
  const { buildPath, jobs } = options;
  const zigObjectPath = join(buildPath, "bun-zig.o");
  const args = ["-j", `${jobs}`];
  if (isVerbose) {
    args.push("-v");
  }

  await cmakeGenerateBunBuild(options, "zig");
  await spawn("ninja", [zigObjectPath, ...args], {
    cwd: buildPath,
    env: {
      ONLY_ZIG: "1",
      ...process.env,
    },
  });
}

/**
 * @param {BuildOptions} options
 */
async function bunCppBuild(options) {
  const { buildPath, os, jobs } = options;

  const shell = os === "windows" ? "pwsh" : "bash";
  const scriptPath = os === "windows" ? "compile-cpp-only.ps1" : "compile-cpp-only.sh";
  const args = ["-j", `${jobs}`];
  if (isVerbose) {
    args.push("-v");
  }

  await cmakeGenerateBunBuild(options, "cpp");
  await spawn(shell, [scriptPath, ...args], { cwd: buildPath });
}

/**
 * @param {BuildOptions} options
 */
async function bunLinkBuild(options) {
  const { buildPath, jobs } = options;
  const args = ["-j", `${jobs}`];
  if (isVerbose) {
    args.push("-v");
  }

  await cmakeGenerateBunBuild(options, "link");
  await spawn("ninja", args, { cwd: buildPath });
  await bunZip(options);
}

/**
 * @param {BuildOptions} options
 */
async function bunBuild(options) {
  const { buildPath, jobs } = options;
  const args = ["-j", `${jobs}`];
  if (isVerbose) {
    args.push("-v");
  }

  await cmakeGenerateBunBuild(options);
  await spawn("ninja", args, { cwd: buildPath });
  await bunZip(options);
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function bunArtifacts(options) {
  const { debug, target } = options;

  let artifacts;
  if (debug) {
    artifacts = ["bun-debug"];
  } else {
    artifacts = ["bun", "bun-profile"];
  }

  if (isCI) {
    return artifacts.map(name => `${name.replace("bun", target)}.zip`);
  }

  return artifacts;
}

/**
 * Creates a zip file for the given build.
 * @param {BuildOptions} options
 */
async function bunZip(options) {
  const { buildPath, debug, os, target } = options;
  const names = debug ? ["bun-debug"] : ["bun", "bun-profile"];

  for (const name of names) {
    const exe = os === "windows" ? `${name}.exe` : name;

    let artifacts;
    if (os === "windows") {
      artifacts = [exe, `${exe}.pdb`];
    } else if (os === "darwin" && !debug) {
      artifacts = [exe, `${exe}.dSYM`];
    } else {
      artifacts = [exe];
    }

    for (const artifact of artifacts) {
      const artifactPath = join(buildPath, artifact);
      if (!isFile(artifactPath)) {
        throw new Error(`Artifact not found: ${artifactPath}`);
      }
    }

    const exePath = join(buildPath, exe);
    chmod(exePath, 0o755);
    const { stdout: revision } = await spawn(exePath, ["--revision"], { silent: true });

    if (isCI) {
      const label = name.replace("bun", target);
      const targetPath = join(buildPath, label);
      mkdir(targetPath, { clean: true });
      for (const artifact of artifacts) {
        copyFile(join(buildPath, artifact), join(targetPath, artifact));
      }

      const zipPath = join(buildPath, `${label}.zip`);
      await zipFile(targetPath, zipPath);
      removeFile(targetPath);
    } else {
      symlinkFile(exePath, join(dirname(buildPath), exe));
    }

    print(`Built ${name} {yellow}v${revision.trim()}{reset}`);
  }
}

/**
 * @param {BuildOptions} options
 * @param {"cpp" | "zig" | "link" | undefined} target
 */
async function cmakeGenerateBunBuild(options, target) {
  const { buildPath, buildId, canary, baseline, lto, assertions, valgrind } = options;
  const baseBuildPath = dirname(buildPath);

  const cpuTarget = getCpuTarget(options);
  const flags = [
    "-DNO_CONFIGURE_DEPENDS=ON",
    `-DCPU_TARGET=${cpuTarget}`,
    buildId && `-DBUILD_ID=${buildId}`,
    canary && `-DCANARY=${canary}`,
    baseline && "-DUSE_BASELINE_BUILD=ON",
    lto && "-DUSE_LTO=ON",
    assertions && "-DUSE_DEBUG_JSC=ON",
    valgrind && "-DUSE_VALGRIND=ON",
  ];

  if (target === "cpp") {
    flags.push("-DBUN_CPP_ONLY=ON");
  } else if (target === "zig") {
    flags.push("-DBUN_ZIG_ONLY=ON", "-DWEBKIT_DIR=omit");
  } else if (target === "link") {
    flags.push("-DBUN_LINK_ONLY=ON", "-DNO_CODEGEN=ON");
  }

  if (!target || target === "zig") {
    const zigTarget = getZigTarget(options);
    const zigOptimize = getZigOptimize(options);

    flags.push(`-DZIG_TARGET=${zigTarget}`, `-DZIG_OPTIMIZE=${zigOptimize}`);
  }

  if (target === "link" || target === "zig") {
    const zigPath = join(baseBuildPath, "bun-zig");
    const zigObjectPath = join(zigPath, "bun-zig.o");

    flags.push(`-DBUN_ZIG_OBJ=${zigObjectPath}`);
  }

  const cppPath = join(baseBuildPath, "bun-cpp");
  const cppArchivePath = join(cppPath, "bun-cpp-objects.a");

  if (target === "link") {
    flags.push(`-DBUN_CPP_ARCHIVE=${cppArchivePath}`);
  }

  const depsPath = join(baseBuildPath, "bun-deps");

  if (!target || target === "link") {
    flags.push(`-DBUN_DEPS_OUT_DIR=${depsPath}`);
  }

  await cmakeGenerateBuild(options, ...flags.filter(Boolean));
}

/**
 * @param {BuildOptions} options
 */
async function bunRuntimeJsBuild(options) {
  const { cwd, clean } = options;
  const srcPath = join(cwd, "src", "runtime.bun.js");
  const outPath = join(cwd, "src", "runtime.out.js");

  if (clean || !isFile(outPath)) {
    await spawn(
      "bunx",
      [
        "esbuild",
        "--bundle",
        "--minify",
        "--target=esnext",
        "--format=esm",
        "--platform=node",
        "--external:/bun:*",
        `--outfile=${outPath}`,
        srcPath,
      ],
      { cwd },
    );
  }
}

/**
 * @param {BuildOptions} options
 */
async function bunFallbackDecoderBuild(options) {
  const { cwd, clean } = options;
  const srcPath = join(cwd, "src", "fallback.ts");
  const outPath = join(cwd, "src", "fallback.out.js");

  if (clean || !isFile(outPath)) {
    await spawn("bun", ["install"], { cwd });
    await spawn(
      "bunx",
      [
        "esbuild",
        "--bundle",
        "--minify",
        "--target=esnext",
        "--format=iife",
        "--platform=browser",
        `--outfile=${outPath}`,
        srcPath,
      ],
      { cwd },
    );
  }
}

/**
 * @param {BuildOptions} options
 */
async function bunErrorBuild(options) {
  const { cwd, clean } = options;
  const outPath = join(cwd, "dist");

  if (clean || !isDirectory(outPath)) {
    await spawn("bun", ["install"], { cwd });
    await spawn(
      "bunx",
      [
        "esbuild",
        "--bundle",
        "--minify",
        "--format=esm",
        "--platform=browser",
        "--define:process.env.NODE_ENV=\"'production'\"",
        `--outdir=${outPath}`,
        "index.tsx",
        "bun-error.css",
      ],
      { cwd },
    );
  }
}

/**
 * @param {BuildOptions} options
 */
async function bunNodeFallbacksBuild(options) {
  const { cwd, clean } = options;
  const outPath = join(cwd, "out");

  if (clean || !isDirectory(outPath)) {
    const filenames = listFiles(cwd).filter(filename => filename.endsWith(".js"));
    await spawn("bun", ["install"], { cwd });
    await spawn(
      "bunx",
      ["esbuild", "--bundle", "--minify", "--format=esm", "--platform=browser", `--outdir=${outPath}`, ...filenames],
      { cwd },
    );
  }
}

/**
 * Build dependencies.
 */

/**
 * @typedef {Object} Artifact
 * @property {string} name
 * @property {string[]} [aliases]
 * @property {string} [cwd]
 * @property {string[]} [artifacts]
 * @property {Function} build
 * @property {string[]} [dependencies]
 */

/**
 * @param {BuildOptions} options
 * @returns {Artifact[]}
 */
function getArtifacts(options) {
  const { os, cwd, buildPath } = options;
  const depsPath = join(cwd, "src", "deps");
  const depsOutPath = join(buildPath, "bun-deps");

  const artifacts = [
    {
      name: "bun",
      dependencies: ["bun-deps"],
      build: bunBuild,
      artifacts: bunArtifacts(options),
    },
    {
      name: "bun-link",
      aliases: ["link"],
      build: bunLinkBuild,
      artifacts: bunArtifacts(options),
    },
    {
      name: "bun-cpp",
      aliases: ["cpp"],
      build: bunCppBuild,
      artifacts: ["bun-cpp-objects.a"],
    },
    {
      name: "bun-zig",
      aliases: ["zig"],
      dependencies: ["bun-error", "bun-node-fallbacks", "bun-fallback-decoder", "bun-runtime-js"],
      build: bunZigBuild,
      artifacts: ["bun-zig.o"],
    },
    {
      name: "bun-node-fallbacks",
      aliases: ["node-fallbacks", "bun-old-js", "old-js"],
      cwd: join(cwd, "src", "node-fallbacks"),
      build: bunNodeFallbacksBuild,
    },
    {
      name: "bun-error",
      aliases: ["bun-old-js", "old-js"],
      cwd: join(cwd, "packages", "bun-error"),
      build: bunErrorBuild,
    },
    {
      name: "bun-fallback-decoder",
      aliases: ["fallback-decoder", "bun-old-js", "old-js"],
      build: bunFallbackDecoderBuild,
    },
    {
      name: "bun-runtime-js",
      aliases: ["runtime-js", "bun-old-js", "old-js"],
      build: bunRuntimeJsBuild,
    },
    {
      name: "boringssl",
      aliases: ["bun-deps", "deps"],
      cwd: join(depsPath, "boringssl"),
      artifacts: boringSslArtifacts(options),
      artifactsPath: depsOutPath,
      build: boringSslBuild,
    },
    {
      name: "cares",
      aliases: ["c-ares", "bun-deps", "deps"],
      cwd: join(depsPath, "c-ares"),
      artifacts: caresArtifacts(options),
      artifactsPath: depsOutPath,
      build: caresBuild,
    },
    {
      name: "libarchive",
      aliases: ["bun-deps", "deps"],
      cwd: join(depsPath, "libarchive"),
      artifacts: libarchiveArtifacts(options),
      artifactsPath: depsOutPath,
      build: libarchiveBuild,
    },
    {
      name: "libdeflate",
      aliases: ["bun-deps", "deps"],
      cwd: join(depsPath, "libdeflate"),
      artifacts: libdeflateArtifacts(options),
      artifactsPath: depsOutPath,
      build: libdeflateBuild,
    },
    {
      name: "lolhtml",
      aliases: ["lol-html", "bun-deps", "deps"],
      cwd: join(depsPath, "lol-html"),
      artifacts: lolhtmlArtifacts(options),
      artifactsPath: depsOutPath,
      build: lolhtmlBuild,
    },
    {
      name: "lshpack",
      aliases: ["ls-hpack", "bun-deps", "deps"],
      cwd: join(depsPath, "ls-hpack"),
      artifacts: lshpackArtifacts(options),
      artifactsPath: depsOutPath,
      build: lshpackBuild,
    },
    {
      name: "mimalloc",
      aliases: ["bun-deps", "deps"],
      cwd: join(depsPath, "mimalloc"),
      artifacts: mimallocArtifacts(options),
      artifactsPath: depsOutPath,
      build: mimallocBuild,
    },
    {
      name: "tinycc",
      aliases: ["bun-deps", "deps"],
      cwd: join(depsPath, "tinycc"),
      artifacts: tinyccArtifacts(options),
      artifactsPath: depsOutPath,
      build: tinyccBuild,
    },
    {
      name: "zlib",
      aliases: ["bun-deps", "deps"],
      cwd: join(depsPath, "zlib"),
      artifacts: zlibArtifacts(options),
      artifactsPath: depsOutPath,
      build: zlibBuild,
    },
    {
      name: "zstd",
      aliases: ["bun-deps", "deps"],
      cwd: join(depsPath, "zstd"),
      artifacts: zstdArtifacts(options),
      artifactsPath: depsOutPath,
      build: zstdBuild,
    },
  ];

  if (os === "windows") {
    artifacts.push({
      name: "libuv",
      aliases: ["bun-deps"],
      cwd: join(depsPath, "libuv"),
      artifacts: libuvArtifacts(options),
      artifactsPath: depsOutPath,
      build: libuvBuild,
    });
  }

  return artifacts;
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function boringSslArtifacts(options) {
  const { os } = options;
  if (os === "windows") {
    return ["crypto.lib", "ssl.lib", "decrepit.lib"];
  }
  return ["libcrypto.a", "libssl.a", "libdecrepit.a"];
}

/**
 * @param {BuildOptions} options
 */
async function boringSslBuild(options) {
  await cmakeGenerateBuild(options);
  await cmakeBuild(options, ...boringSslArtifacts(options));
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function caresArtifacts(options) {
  const libPath = "lib";
  const { os } = options;
  if (os === "windows") {
    return [join(libPath, "cares.lib")];
  }
  return [join(libPath, "libcares.a")];
}

/**
 * @param {BuildOptions} options
 */
async function caresBuild(options) {
  await cmakeGenerateBuild(
    { ...options, pic: true },
    "-DCARES_STATIC=ON",
    "-DCARES_STATIC_PIC=ON",
    "-DCARES_SHARED=OFF",
  );
  await cmakeBuild(options, ...caresArtifacts(options));
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function libarchiveArtifacts(options) {
  const { os } = options;
  const libPath = "libarchive";
  if (os === "windows") {
    return [join(libPath, "archive.lib")];
  }
  return [join(libPath, "libarchive.a")];
}

/**
 * @param {BuildOptions} options
 */
async function libarchiveBuild(options) {
  await cmakeGenerateBuild(
    { ...options, pic: true },
    "-DBUILD_SHARED_LIBS=0",
    "-DENABLE_BZIP2=0",
    "-DENABLE_CAT=0",
    "-DENABLE_EXPAT=0",
    "-DENABLE_ICONV=0",
    "-DENABLE_INSTALL=0",
    "-DENABLE_LIBB2=0",
    "-DENABLE_LibGCC=0",
    "-DENABLE_LIBXML2=0",
    "-DENABLE_LZ4=0",
    "-DENABLE_LZMA=0",
    "-DENABLE_LZO=0",
    "-DENABLE_MBEDTLS=0",
    "-DENABLE_NETTLE=0",
    "-DENABLE_OPENSSL=0",
    "-DENABLE_PCRE2POSIX=0",
    "-DENABLE_PCREPOSIX=0",
    "-DENABLE_TEST=0",
    "-DENABLE_WERROR=0",
    "-DENABLE_ZLIB=0",
    "-DENABLE_ZSTD=0",
  );
  await cmakeBuild(options, "archive_static");
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function libdeflateArtifacts(options) {
  const { os } = options;
  if (os === "windows") {
    return ["deflatestatic.lib"];
  }
  return ["libdeflate.a"];
}

/**
 * @param {BuildOptions} options
 */
async function libdeflateBuild(options) {
  await cmakeGenerateBuild(
    options,
    "-DLIBDEFLATE_BUILD_STATIC_LIB=ON",
    "-DLIBDEFLATE_BUILD_SHARED_LIB=OFF",
    "-DLIBDEFLATE_BUILD_GZIP=OFF",
  );
  await cmakeBuild(options, ...libdeflateArtifacts(options));
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function libuvArtifacts(options) {
  const { os } = options;
  if (os === "windows") {
    return ["libuv.lib"];
  }
  return [];
}

/**
 * @param {BuildOptions} options
 */
async function libuvBuild(options) {
  const { cwd } = options;
  await gitClone({
    cwd,
    url: "https://github.com/libuv/libuv",
    commit: "da527d8d2a908b824def74382761566371439003",
  });
  await cmakeGenerateBuild(options, "-DCMAKE_C_FLAGS=/DWIN32 /D_WINDOWS -Wno-int-conversion");
  await cmakeBuild(options);
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function lolhtmlArtifacts(options) {
  const target = getRustTarget(options);
  const { os, debug } = options;
  const targetPath = join(target, debug ? "debug" : "release");
  if (os === "windows") {
    return [join(targetPath, "lolhtml.lib"), join(targetPath, "lolhtml.pdb")];
  }
  return [join(targetPath, "liblolhtml.a")];
}

/**
 * @param {BuildOptions} options
 */
async function lolhtmlBuild(options) {
  const { cwd } = options;
  const srcPath = join(cwd, "c-api");
  await cargoBuild({ ...options, cwd: srcPath });
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function lshpackArtifacts(options) {
  const { os } = options;
  if (os === "windows") {
    return ["ls-hpack.lib"];
  }
  return ["libls-hpack.a"];
}

/**
 * @param {BuildOptions} options
 */
async function lshpackBuild(options) {
  // FIXME: There is a linking issue with lshpack built in debug mode or debug symbols
  await cmakeGenerateBuild({ ...options, debug: false, debugSymbols: false }, "-DLSHPACK_XXH=ON", "-DSHARED=0");
  await cmakeBuild(options, ...lshpackArtifacts(options));
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function mimallocArtifacts(options) {
  const { os, debug } = options;
  const name = debug ? "libmimalloc-debug" : "libmimalloc";
  if (os === "windows") {
    return [`${name}.lib`];
  }
  return [`${name}.a`, `${name}.o`];
}

/**
 * @param {BuildOptions} options
 */
async function mimallocBuild(options) {
  const { os, debug, valgrind, buildPath } = options;
  const flags = [
    "-DMI_SKIP_COLLECT_ON_EXIT=1",
    "-DMI_BUILD_SHARED=OFF",
    "-DMI_BUILD_STATIC=ON",
    "-DMI_BUILD_TESTS=OFF",
    "-DMI_OSX_ZONE=OFF",
    "-DMI_OSX_INTERPOSE=OFF",
    "-DMI_BUILD_OBJECT=ON",
    "-DMI_USE_CXX=ON",
    "-DMI_OVERRIDE=OFF",
    "-DMI_OSX_ZONE=OFF",
  ];
  if (debug) {
    flags.push("-DMI_DEBUG_FULL=1");
  }
  if (valgrind) {
    flags.push("-DMI_TRACK_VALGRIND=ON");
  }
  await cmakeGenerateBuild(options, ...flags);
  await cmakeBuild(options);
  if (os !== "windows") {
    const objectPath = join(buildPath, "CMakeFiles", "mimalloc-obj.dir", "src", "static.c.o");
    const name = debug ? "libmimalloc-debug" : "libmimalloc";
    copyFile(objectPath, join(buildPath, `${name}.o`));
  }
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function tinyccArtifacts(options) {
  const { os } = options;
  if (os === "windows") {
    return ["tcc.lib"];
  }
  return ["libtcc.a"];
}

/**
 * @param {BuildOptions} options
 */
async function tinyccBuild(options) {
  const { os, cwd, buildPath, cc, ccache, ar, debug, clean, jobs } = options;

  // tinycc doesn't support out-of-source builds, so we need to copy the source
  // directory to the build directory.
  if (!isDirectory(buildPath) || clean) {
    removeFile(buildPath);
    copyFile(cwd, buildPath);
  }

  const cflags = getCFlags(options);
  const ldflags = getLdFlags(options);
  const ccOrCcache = ccache ? `${ccache} ${cc}` : cc;

  async function posixBuild() {
    const args = [
      "--config-predefs=yes",
      "--enable-static",
      `--cc=${ccOrCcache}`,
      `--extra-cflags=${cflags.join(" ")}`,
      `--ar=${ar}`,
      `--extra-ldflags=${ldflags.join(" ")}`,
    ];
    if (debug) {
      args.push("--debug");
    }
    await spawn("./configure", args, { cwd: buildPath });

    // There is a bug in configure that causes it to use the wrong compiler.
    // We need to patch the config.mak file to use the correct compiler.
    const configPath = join(buildPath, "config.mak");
    if (!isFile(configPath)) {
      throw new Error("Could not find file: config.mak");
    }
    const configText = readFile(configPath, "utf-8");
    if (!configText.includes(ccOrCcache)) {
      writeFile(configPath, configText.replace(/CC=[^\n]+/g, `CC=${ccOrCcache}`));
      print("Patched config.mak");
    }

    await spawn("make", ["libtcc.a", "-j", `${jobs}`], { cwd: buildPath });
  }

  async function windowsBuild() {
    const version = readFile(join(cwd, "VERSION"), "utf-8");
    const { stdout: revision } = spawnSync("git", ["rev-parse", "HEAD"], { cwd });
    const configText = `#define TCC_VERSION "${version.trim()}"
#define TCC_GITHASH "${revision.trim()}"
#define CONFIG_TCCDIR "${cwd.replace(/\\/g, "/")}"
#define CONFIG_TCC_PREDEFS 1
#ifdef TCC_TARGET_X86_64
#define CONFIG_TCC_CROSSPREFIX "${process.env["PX"]}%-"
#endif
`;
    writeFile(join(buildPath, "config.h"), configText);
    print("Generated config.h");

    await spawn(
      cc,
      ["-DTCC_TARGET_PE", "-DTCC_TARGET_X86_64", "config.h", "-DC2STR", "-o", "c2str.exe", "conftest.c"],
      { cwd: buildPath },
    );
    await spawn(".\\c2str.exe", [".\\include\\tccdefs.h", "tccdefs_.h"], { cwd: buildPath });
    await spawn(
      cc,
      [
        ...cflags,
        "libtcc.c",
        "-o",
        "tcc.obj",
        "-DTCC_TARGET_PE",
        "-DTCC_TARGET_X86_64",
        "-O2",
        "-W2",
        "-Zi",
        "-MD",
        "-GS-",
        "-c",
        "-MT",
      ],
      { cwd: buildPath },
    );
    await spawn(ar, ["tcc.obj", "-OUT:tcc.lib"], { cwd: buildPath });
  }

  if (os === "windows") {
    await windowsBuild();
  } else {
    await posixBuild();
  }
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function zlibArtifacts(options) {
  const { os } = options;
  if (os === "windows") {
    return ["zlib.lib"];
  }
  return ["libz.a"];
}

/**
 * @param {BuildOptions} options
 */
async function zlibBuild(options) {
  const { os, cwd } = options;

  // TODO: Make a patch to zlib for clang-cl, which implements `__builtin_ctzl` and `__builtin_expect`
  if (os === "windows") {
    const filePath = join(cwd, "deflate.h");
    const fileContent = readFile(filePath, "utf-8");
    const start = fileContent.lastIndexOf("#ifdef _MSC_VER");
    const end = fileContent.lastIndexOf("#else");
    if (start !== -1 && end !== -1) {
      writeFile(filePath, fileContent.slice(0, start) + "#ifdef FALSE\n" + fileContent.slice(end));
      print("Patched deflate.h");
    }
  }

  await cmakeGenerateBuild(options);
  await cmakeBuild(options, ...zlibArtifacts(options));
}

/**
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function zstdArtifacts(options) {
  const { os } = options;
  const libPath = "lib";
  if (os === "windows") {
    return [join(libPath, "zstd_static.lib")];
  }
  return [join(libPath, "libzstd.a")];
}

/**
 * @param {BuildOptions} options
 */
async function zstdBuild(options) {
  const { cwd } = options;
  const cmakePath = join(cwd, "build", "cmake");
  await cmakeGenerateBuild({ ...options, cwd: cmakePath }, "-DZSTD_BUILD_STATIC=ON");
  await cmakeBuild(options, ...zstdArtifacts(options));
}

/**
 * C/C++ compiler flags.
 */

/**
 * Gets the C flags for the given options.
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function getCFlags(options) {
  const { cwd, debug, os, arch, baseline, lto, pic, osxVersion, llvmVersion, artifact } = options;
  const flags = [];

  // Relocates debug info from an absolute path to a relative path
  // https://ccache.dev/manual/4.8.2.html#_compiling_in_different_directories
  if (os !== "windows") {
    flags.push(`-fdebug-prefix-map=${cwd}=.`);
  }

  if (os !== "windows") {
    flags.push("-fansi-escape-codes", "-fdiagnostics-color=always");
  }

  if (os === "windows") {
    flags.push("/Z7", "/MT", "/Ob2", "/DNDEBUG", "/U_DLL");
    if (!debug) {
      flags.push("/O2");
    }
  } else {
    flags.push(
      "-fno-exceptions",
      "-fvisibility=hidden",
      "-fvisibility-inlines-hidden",
      "-mno-omit-leaf-frame-pointer",
      "-fno-omit-frame-pointer",
      "-fno-asynchronous-unwind-tables",
      "-fno-unwind-tables",
    );
    if (!debug) {
      flags.push("-O3");
    }
  }

  if (arch === "x64") {
    if (baseline) {
      flags.push("-march=nehalem");
    } else {
      flags.push("-march=haswell");
    }
  } else if (arch === "aarch64") {
    if (os === "darwin") {
      flags.push("-mcpu=apple-m1");
    } else {
      flags.push("-march=armv8-a+crc", "-mtune=ampere1");
    }
  }

  if (os === "linux") {
    flags.push("-ffunction-sections", "-fdata-sections", "-faddrsig");
  } else if (os === "darwin") {
    if (osxVersion) {
      flags.push(`-mmacosx-version-min=${osxVersion}`);
    }

    // Clang 18 on macOS needs to have -fno-define-target-os-macros to fix a zlib build issue:
    // https://gitlab.kitware.com/cmake/cmake/-/issues/25755
    if (artifact === "zlib" && compareSemver(llvmVersion, "18") >= 0) {
      flags.push("-fno-define-target-os-macros");
    }

    flags.push("-D__DARWIN_NON_CANCELABLE=1");
  }

  if (lto) {
    if (os === "windows") {
      flags.push("-flto", "-Xclang", "-emit-llvm-bc");
      flags.push("-fuse-ld=lld");
    } else {
      flags.push("-flto=full");
    }
  }

  if (pic) {
    flags.push("-fPIC");
  } else if (os === "linux") {
    flags.push("-fno-pie", "-fno-pic");
  }

  return flags;
}

/**
 * Gets the C++ flags for the given options.
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function getCxxFlags(options) {
  const { os, lto, artifact } = options;
  const flags = getCFlags(options);

  if (os !== "windows") {
    flags.push("-fno-rtti", "-fno-c++-static-destructors");
    if (lto) {
      flags.push("-fwhole-program-vtables", "-fforce-emit-vtables");
    }
  }

  // Fixes build issue with libc++ on macOS 13.0
  // https://github.com/oven-sh/bun/pull/12860
  if (os === "darwin" && artifact !== "bun") {
    flags.push("-D_LIBCXX_ENABLE_ASSERTIONS=0", "-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_NONE");
  }

  return flags;
}

/**
 * Gets the linker flags for the given options.
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function getLdFlags(options) {
  const { os, lto, ld } = options;
  const flags = [];

  if (ld) {
    if (exists(ld)) {
      flags.push(`--ld-path=${ld}`);
    } else {
      flags.push(`-fuse-ld=${ld}`);
    }
  }

  if (os === "linux") {
    flags.push("-Wl,-z,norelro");
  }

  if (lto && os !== "windows") {
    flags.push("-flto=full", "-fwhole-program-vtables", "-fforce-emit-vtables");
  }

  return flags;
}

/**
 * Gets the CMake flags for the given options.
 * @param {BuildOptions} options
 * @returns {string[]}
 */
function getCmakeFlags(options) {
  const { cwd, buildPath, debug, debugSymbols, os, osxVersion } = options;
  const { cc, cxx, ar, ranlib, ld, ccache } = options;

  /**
   * @param {string} path
   * @returns {string}
   */
  function cmakePath(path) {
    // clang-cl doesn't support unescaped backslashes, otherwise it fails with:
    // Invalid character escape '\U'
    if (os === "windows") {
      return path.replace(/\\/g, "/");
    }
    return path;
  }

  const flags = [
    `-S ${cmakePath(cwd)}`,
    `-B ${cmakePath(buildPath)}`,
    "-GNinja",
    "-DCMAKE_C_STANDARD=17",
    "-DCMAKE_C_STANDARD_REQUIRED=ON",
    "-DCMAKE_CXX_STANDARD=20",
    "-DCMAKE_CXX_STANDARD_REQUIRED=ON",
    "-DCMAKE_COLOR_DIAGNOSTICS=ON",
  ];

  if (debug) {
    flags.push("-DCMAKE_BUILD_TYPE=Debug");
  } else if (debugSymbols) {
    flags.push("-DCMAKE_BUILD_TYPE=RelWithDebInfo");
  } else {
    flags.push("-DCMAKE_BUILD_TYPE=Release");
  }

  if (cc) {
    flags.push(`-DCMAKE_C_COMPILER=${cmakePath(cc)}`, "-DCMAKE_C_COMPILER_WORKS=ON");
  }

  const cflags = getCFlags(options);
  if (cflags.length) {
    flags.push(`-DCMAKE_C_FLAGS=${cflags.join(" ")}`);
  }

  if (cxx) {
    flags.push(`-DCMAKE_CXX_COMPILER=${cmakePath(cxx)}`, "-DCMAKE_CXX_COMPILER_WORKS=ON");
  }

  const cxxflags = getCxxFlags(options);
  if (cxxflags.length) {
    flags.push(`-DCMAKE_CXX_FLAGS=${cxxflags.join(" ")}`);
  }

  if (ld) {
    flags.push(`-DCMAKE_LINKER=${cmakePath(ld)}`);
  }

  const ldflags = getLdFlags(options);
  if (ldflags.length) {
    flags.push(`-DCMAKE_LINKER_FLAGS=${ldflags.join(" ")}`, `-DCMAKE_EXE_LINKER_FLAGS=${ldflags.join(" ")}`);
  }

  if (ar) {
    flags.push(`-DCMAKE_AR=${cmakePath(ar)}`);
  }

  if (ranlib) {
    flags.push(`-DCMAKE_RANLIB=${cmakePath(ranlib)}`);
  }

  if (ccache) {
    flags.push(
      `-DCMAKE_C_COMPILER_LAUNCHER=${cmakePath(ccache)}`,
      `-DCMAKE_CXX_COMPILER_LAUNCHER=${cmakePath(ccache)}`,
    );
  }

  if (os === "darwin" && osxVersion) {
    flags.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${osxVersion}`);
  }

  if (os === "linux") {
    // WebKit is built with -std=gnu++20 on Linux
    // If not specified, the build crashes on the first memory allocation
    flags.push("-DCMAKE_CXX_EXTENSIONS=ON");
  }

  if (os === "windows") {
    // Bug with cmake and clang-cl where "Note: including file:" is saved in the file path
    // https://github.com/ninja-build/ninja/issues/2280
    flags.push("-DCMAKE_CL_SHOWINCLUDES_PREFIX=Note: including file:");

    // Generates a .pdb file with debug symbols, only works with cmake 3.25+
    flags.push("-DCMAKE_MSVC_DEBUG_INFORMATION_FORMAT=Embedded", "-DCMAKE_POLICY_CMP0141=NEW");

    // Selects the MSVC runtime library that supports statically-linked and multi-threaded
    flags.push(`-DCMAKE_MSVC_RUNTIME_LIBRARY=${debug ? "MultiThreadedDebug" : "MultiThreaded"}`);
  }

  if (isVerbose) {
    // Generates a compile_commands.json file with a list of compiler commands
    flags.push("-DCMAKE_EXPORT_COMPILE_COMMANDS=ON");

    flags.push("--log-level=VERBOSE", "-DCMAKE_VERBOSE_MAKEFILE=ON");
  }

  // ?
  // CMAKE_APPLE_SILICON_PROCESSOR
  // CMAKE_<LANG>_CPPCHECK
  // CMAKE_<LANG>_CPPLINT
  // CMAKE_OSX_DEPLOYMENT_TARGET
  // CMAKE_OSX_SYSROOT

  return flags.filter(Boolean);
}

/**
 * @param {string} [llvmVersion]
 */
function getLlvmPath(llvmVersion) {
  const llvmMajorVersion = llvmVersion?.split(".")[0];

  if (isMacOS) {
    const brewName = llvmMajorVersion ? `llvm@${llvmMajorVersion}` : "llvm";
    const { stdout } = spawnSync("brew", ["--prefix", brewName], { throwOnError: false });
    const llvmPath = join(stdout.trim(), "bin");
    if (isDirectory(llvmPath)) {
      return llvmPath;
    }
  }
}

/**
 * Build commands.
 */

/**
 * Runs CMake to generate the build files.
 * @param {BuildOptions} options
 * @param {...string} extraArgs
 */
async function cmakeGenerateBuild(options, ...extraArgs) {
  const args = getCmakeFlags(options);

  await spawn("cmake", [...args, ...extraArgs]);
}

/**
 * Runs CMake to build the project.
 * @param {BuildOptions} options
 * @param {string[]} [targets]
 */
async function cmakeBuild(options, ...targets) {
  const { cwd, buildPath, debug, clean, jobs } = options;
  const args = ["--build", buildPath || ".", "--parallel", `${jobs}`];

  if (debug) {
    args.push("--config", "Debug");
  } else {
    args.push("--config", "Release");
  }

  if (clean) {
    args.push("--clean-first");
  }

  for (const target of targets) {
    args.push("--target", basename(target));
  }

  await spawn("cmake", args, { cwd });
}

/**
 * Runs cargo to build a Rust project.
 * @param {BuildOptions} options
 * @param {string} [target]
 */
async function cargoBuild(options) {
  const { os, cwd, buildPath, debug, jobs } = options;

  const target = getRustTarget(options);
  const args = ["build", "--target-dir", buildPath, "--target", target, "--jobs", `${jobs}`];
  if (!debug) {
    args.push("--release");
  }
  if (isVerbose) {
    args.push("--verbose");
  }

  // FIXME: cargo is not set to PATH on Linux CI
  if (isCI && os === "linux") {
    addToPath(join(process.env["HOME"], ".cargo", "bin"));
  }

  await spawn("cargo", args, { cwd });
}

/**
 * Environment variables.
 */

/**
 * Gets whether the environment variable is required by the system.
 * @param {string} name
 * @returns {boolean}
 */
function isSystemEnv(name) {
  return (
    /^(?:PATH|HOME|USER|TERM)$/i.test(name) ||
    /^(?:TMP|TEMP|TMPDIR|TEMPDIR|RUNNER_TEMP)$/i.test(name) ||
    (isWindows && /PATHEXT|USER|SYSTEM|APPDATA|PROGRAMDATA|PROGRAMFILES|PROCESSOR|WINDIR|/i.test(name)) ||
    (isMacOS && /^HOMEBREW/i.test(name)) ||
    (isCI && /^CI/i.test(name)) ||
    (isGithubAction && /^(?:GITHUB|RUNNER)/i.test(name)) ||
    (isBuildKite && /^BUILDKITE/i.test(name))
  );
}

/**
 * Gets the environment variables for building bun.
 * @param {BuildOptions} options
 */
function getBuildEnv(options) {
  const env = {
    ...getCcacheEnv(options),
    ...getZigEnv(options),
    ...getBunEnv(options),
  };

  const gitSha = getGitSha();
  if (gitSha) {
    env["GIT_SHA"] = gitSha;
  }

  if (isCI) {
    env["TERM"] = "xterm-256color";
  }

  return env;
}

/**
 * Gets the environment variables for ccache.
 * @param {BuildOptions} options
 * @returns {Record<string, string>}
 */
function getCcacheEnv(options) {
  const { cwd, cachePath, cacheStrategy, artifact } = options;
  const ccacheBasePath = cachePath || join(cwd, ".cache");
  const ccachePath = join(ccacheBasePath, "ccache");

  // https://ccache.dev/manual/4.8.2.html#_configuration_options
  const env = {
    "CCACHE_BASEDIR": cwd,
    "CCACHE_DIR": ccachePath,
    "CCACHE_NOHASHDIR": "1", // Do not hash the cwd
    "CCACHE_SLOPPINESS": "gcno_cwd,pch_defines,time_macros,include_file_mtime,include_file_ctime",
  };

  if (cacheStrategy === "read") {
    env["CCACHE_READONLY"] = "1";
  } else if (cacheStrategy === "write") {
    env["CCACHE_RECACHE"] = "1";
  } else if (cacheStrategy === "none") {
    env["CCACHE_DISABLE"] = "1";
  }

  // Use a different cache namespace for each artifact
  if (artifact) {
    env["CCACHE_NAMESPACE"] = artifact;
  }

  // Use clonefile() for faster copying, if available
  // However, this disabled compression, so we need to use a larger cache
  if (isCI) {
    env["CCACHE_FILECLONE"] = "1";
    env["CCACHE_MAXSIZE"] = "50G";
  }

  return env;
}

/**
 * Gets the environment variables for zig.
 * @param {BuildOptions} options
 * @returns {Record<string, string>}
 */
function getZigEnv(options) {
  const { cwd, cachePath, buildPath } = options;
  const zigBasePath = cachePath || join(cwd, ".cache");
  const zigCachePath = join(zigBasePath, "zig-cache");

  // TODO: zig-cache is not realiable in CI due to concurrent access
  // For example, sometimes it will just hang the build forever.
  if (isCI) {
    const tmpZigCachePath = join(buildPath, "zig-cache");
    return {
      "ZIG_CACHE_DIR": tmpZigCachePath,
      "ZIG_GLOBAL_CACHE_DIR": tmpZigCachePath,
    };
  }

  return {
    "ZIG_CACHE_DIR": zigCachePath,
    "ZIG_GLOBAL_CACHE_DIR": zigCachePath,
  };
}

/**
 * Gets the environment variables for bun.
 * @param {BuildOptions} options
 * @returns {Record<string, string>}
 */
function getBunEnv(options) {
  const { cachePath, cwd } = options;
  const bunBasePath = cachePath || join(cwd, ".cache");
  const bunCachePath = join(bunBasePath, "bun-install");

  return {
    "BUN_FEATURE_FLAG_INTERNAL_FOR_TESTING": "1",
    "BUN_DEBUG_QUIET_LOGS": "1",
    "BUN_GARBAGE_COLLECTOR_LEVEL": "1",
    "BUN_ENABLE_CRASH_REPORTING": "0",
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
    "BUN_INSTALL_CACHE_DIR": bunCachePath,
  };
}

/**
 * Miscellaneous utilities.
 */

/**
 * Gets the Rust target for the given options.
 * @param {BuildOptions} options
 * @returns {string}
 */
function getRustTarget(options) {
  const { os, arch } = options;
  const target = `${os}-${arch}`;
  switch (target) {
    case "windows-x64":
      return "x86_64-pc-windows-msvc";
    case "linux-x64":
      return "x86_64-unknown-linux-gnu";
    case "linux-aarch64":
      return "aarch64-unknown-linux-gnu";
    case "darwin-x64":
      return "x86_64-apple-darwin";
    case "darwin-aarch64":
      return "aarch64-apple-darwin";
    default:
      throw new Error(`Unsupported Rust target: ${target}`);
  }
}

/**
 * Gets the Zig target for the given options.
 * @param {BuildOptions} options
 * @returns {string}
 */
function getZigTarget(options) {
  const { os, arch } = options;
  const target = `${os}-${arch}`;
  switch (target) {
    case "windows-x64":
      return "x86_64-windows-msvc";
    case "linux-x64":
      return "x86_64-linux-gnu";
    case "linux-aarch64":
      return "aarch64-linux-gnu";
    case "darwin-x64":
      return "x86_64-macos-none";
    case "darwin-aarch64":
      return "aarch64-macos-none";
    default:
      throw new Error(`Unsupported Zig target: ${target}`);
  }
}

/**
 * Gets the zig optimize level for the given options.
 * @param {BuildOptions} options
 * @returns {string}
 */
function getZigOptimize(options) {
  const { debug, assertions, os } = options;
  if (debug) {
    return "Debug";
  }
  if (assertions || os === "windows") {
    return "ReleaseSafe";
  }
  return "ReleaseFast";
}

/**
 * Gets the CPU target for the given options.
 * @param {BuildOptions} options
 * @returns {string}
 */
function getCpuTarget(options) {
  const { arch, baseline } = options;
  if (baseline) {
    return "nehalem";
  }
  if (arch === "x64") {
    return "haswell";
  }
  return "native";
}

await main();
