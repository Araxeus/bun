#!/usr/bin/env node

/**
 * This script builds bun and its dependencies.
 */

import { basename } from "node:path";
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
  chmod,
  spawn,
  gitClone,
  parseTarget,
  parseOs,
  parseArch,
  getCpus,
  getGitPullRequest,
  getBuildNumber,
  gitClean,
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
} from "./util.mjs";

/**
 * @typedef {Object} BuildOptions
 * @property {string} cwd
 * @property {string} buildPath
 * @property {"linux" | "darwin" | "windows"} os
 * @property {"x64" | "aarch64"} arch
 * @property {boolean} [baseline]
 * @property {string} [target]
 * @property {boolean} [crossCompile]
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
    defaultValue: undefined,
  });

  const os = getOption({
    name: "os",
    description: "The target operating system (e.g. linux, darwin, windows)",
    parse: parseOs,
    defaultValue: customTarget || process.platform,
  });

  const arch = getOption({
    name: "arch",
    description: "The target architecture (e.g. x64, aarch64)",
    parse: parseArch,
    defaultValue: customTarget || process.arch,
  });

  const baseline = getOption({
    name: "baseline",
    env: "USE_BASELINE_BUILD",
    description: "If the target should be built for baseline",
    type: "boolean",
    defaultValue: customTarget?.includes("-baseline"),
  });

  const target = getOption({
    name: "target",
    description: "The target to build (e.g. bun-linux-x64)",
    parse: parseTarget,
    defaultValue: () => {
      if (customTarget) {
        return customTarget;
      }
      if (baseline) {
        return `bun-${os}-${arch}-baseline`;
      }
      return `bun-${os}-${arch}`;
    },
  });

  const crossCompile = getOption({
    name: "cross-compile",
    description: "If the target can be cross-compiled (only Zig)",
    type: "boolean",
    defaultValue: false,
  });

  const debug = getOption({
    name: "debug",
    env: "BUN_DEBUG",
    description: "If the target should be built in debug mode",
    type: "boolean",
    defaultValue: false,
  });

  const lto = getOption({
    name: "lto",
    env: "USE_LTO",
    description: "If the target should be built with link-time optimization (LTO)",
    type: "boolean",
    defaultValue: !debug && os === "linux",
  });

  const valgrind = getOption({
    name: "valgrind",
    env: "USE_VALGRIND",
    description: "If mimalloc should be built with valgrind",
    type: "boolean",
    defaultValue: false,
  });

  const assertions = getOption({
    name: "assertions",
    env: "USE_DEBUG_JSC",
    description: "If debug assertions should be enabled",
    type: "boolean",
    defaultValue: debug,
  });

  const canary = getOption({
    name: "canary",
    description: "If the build is a canary build",
    type: "number",
    defaultValue: 1,
  });

  const isBuild = getOption({
    name: "is-build",
    description: "If the build is a non-release build (e.g. from a PR or commit)",
    type: "boolean",
    defaultValue: isCI ? () => !!getGitPullRequest() : undefined,
  });

  const buildNumber = getOption({
    name: "build-number",
    description: "The build number",
    type: "number",
    defaultValue: isCI ? getBuildNumber : undefined,
  });

  const clean = getOption({
    name: "clean",
    description: "If directories should be cleaned before building",
    type: "boolean",
  });

  const osxVersion = getOption({
    name: "min-macos-version",
    description: "The minimum version of macOS to target",
    defaultValue: (isCI && os === "darwin" && "13.0") || undefined,
  });

  const llvmVersion = getOption({
    name: "llvm-version",
    description: "The LLVM version to use",
    defaultValue: os === "linux" ? "16.0.6" : "18.1.8",
  });

  const skipLlvmVersion = getOption({
    name: "skip-llvm-version",
    description: "If the LLVM version should be ignored (skip checks for LLVM version of CC, CXX, AR, etc)",
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
    throwIfNotFound: !skipLlvmVersion && os !== "windows",
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
    defaultValue: () => process.cwd(),
  });

  const buildPath = getOption({
    name: "build",
    description: "The build directory",
    defaultValue: () => resolve(cwd, "build", debug ? "debug" : "release", target),
  });

  const cachePath = getOption({
    name: "cache-path",
    description: "The path to use for build caching",
    defaultValue: () => {
      const homePath = process.env["HOME"];
      if (isCI && homePath) {
        return resolve(homePath, ".cache", debug ? "debug" : "release", target);
      }
      return resolve(cwd, ".cache");
    },
  });

  const noCache = getOption({
    name: "no-cache",
    description: "If the build caching should be disabled",
    type: "boolean",
  });

  const cacheStrategy = noCache
    ? "none"
    : getOption({
        name: "cache-strategy",
        description: "The strategy for build caching (e.g. read-write, read, write, none)",
        defaultValue: noCache ? "none" : "read-write",
      });

  /**
   * @type {BuildOptions}
   */
  const options = {
    os,
    arch,
    baseline,
    target,
    crossCompile,
    lto,
    debug,
    valgrind,
    assertions,
    canary,
    isBuild,
    buildNumber,
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

  const args = process.argv.slice(2).filter(arg => !arg.startsWith("-"));

  const printAndExit = getOption({
    name: "print",
    description: "Print the options and exit",
    type: "boolean",
  });

  if (printAndExit || isCI) {
    await runTask("Options", () => console.log(options));
    await runTask("Environment", () => console.log(process.env));
    if (printAndExit) {
      process.exit(0);
    }
  }

  if (args.length) {
    for (const arg of args) {
      await build(arg, options);
    }
  } else {
    await build("bun", options);
  }
}

/**
 * Runs a build.
 * @param {string} name
 * @param {BuildOptions} options
 */
export async function build(name, options = {}) {
  if (!name.startsWith("bun")) {
    return buildDependency(name, options);
  }

  switch (name) {
    case "bun":
      return buildBun(options);
    case "bun-deps":
      return buildDependencies(options);
    default:
      return buildDependency(name, options);
  }
}

/**
 * Build bun.
 */

/**
 * @param {BuildOptions} options
 * @param {"deps" | "cpp" | "zig" | "link" | undefined} target
 */
async function buildBun(options, target) {
  const { buildPath: basePath, clean, jobs } = options;

  const depsPath = join(basePath, "bun-deps");
  const zigPath = join(basePath, "bun-zig", "bun-zig.o");
  const cppPath = join(basePath, "bun-cpp", "bun-cpp-objects.a");

  const buildPath = join(basePath, target ? `bun-${target}` : "bun");
  const buildOptions = {
    ...options,
    artifact: "bun",
    buildPath: buildPath,
  };

  const cleanPath = target ? basePath : buildPath;
  if (clean) {
    removeFile(cleanPath);
  }

  const { baseline, lto, valgrind, assertions, canary, isBuild, buildNumber } = options;

  const flags = ["-DNO_CONFIGURE_DEPENDS=ON", `-DBUN_DEPS_OUT_DIR=${depsPath}`];
  if (buildNumber) {
    flags.push(`-DBUILD_NUMBER=${buildNumber}`);
  }
  if (isBuild) {
    flags.push(`-DBUILD=true`);
  }
  if (canary) {
    flags.push(`-DCANARY=${canary}`);
  }
  if (baseline) {
    flags.push("-DUSE_BASELINE_BUILD=ON");
  }
  if (lto) {
    flags.push("-DUSE_LTO=ON");
  }
  if (assertions) {
    flags.push("-DUSE_DEBUG_JSC=ON");
  }
  if (valgrind) {
    flags.push("-DUSE_VALGRIND=ON");
  }

  if (target === "cpp") {
    flags.push("-DBUN_CPP_ONLY=ON");
  } else if (target === "zig") {
    const zigTarget = getZigTarget(options);
    flags.push(`-DZIG_TARGET=${zigTarget}`, "-DWEBKIT_DIR=omit", `-DBUN_ZIG_OBJ=${zigPath}`);
  } else if (target === "link") {
    flags.push("-DBUN_LINK_ONLY=1", `-DBUN_CPP_ARCHIVE=${cppPath}`, `-DBUN_ZIG_OBJ=${zigPath}`);
  }

  if (!target || target === "zig") {
    await buildBunOldJs(options);
  }

  if (!target) {
    await buildDependencies(options);
  }

  await cmakeGenerateBuild(buildOptions, ...flags);

  const args = ["-j", `${jobs}`];
  if (isVerbose) {
    args.push("-v");
  }

  function buildCpp() {
    const scriptPath = os === "windows" ? "compile-cpp-only.ps1" : "compile-cpp-only.sh";
    const shell = os === "windows" ? "pwsh" : "bash";
    return spawn(shell, [scriptPath, ...args], { cwd: buildPath });
  }

  if (target) {
    const args = ["-j", `${jobs}`];
    if (isVerbose) {
      args.push("-v");
    }
    if (target === "cpp") {
      const scriptPath = join(buildPath, os === "windows" ? "compile-cpp-only.ps1" : "compile-cpp-only.sh");
      const shell = os === "windows" ? "pwsh" : "bash";
      await spawn(shell, [scriptPath, ...args], { cwd: buildPath });
    } else if (target === "zig") {
      await spawn("ninja", [join(buildPath, "bun-zig.o"), ...args], {
        cwd: buildPath,
        env: { ...process.env, ONLY_ZIG: "1" },
      });
    } else {
      await spawn("ninja", args, { cwd: buildPath });
    }
  } else {
    await cmakeBuild(buildOptions);
  }

  if (!target || target === "link") {
    const name = debug ? "bun-debug" : "bun";
    const exe = os === "windows" ? `${name}.exe` : name;
    const exePath = join(buildPath, exe);
    if (!isFile(exePath)) {
      throw new Error(`Bun executable not found: ${exePath}`);
    }
    chmod(exePath, 0o755);
    await spawn(exePath, ["--revision"], { env: { BUN_DEBUG_QUIET_LOGS: "1" } });
  }
}

/**
 * @param {BuildOptions} options
 */
async function buildBunOldJs(options) {
  await runTask("Building old-js", () => buildBunRuntimeJs(options));
  await runTask("Building fallback-decoder", () => buildBunFallbackDecoder(options));
  await runTask("Building bun-error", () => buildBunError(options));
  await runTask("Building node-fallbacks", () => buildBunNodeFallbacks(options));
}

/**
 * @param {BuildOptions} options
 */
async function buildBunRuntimeJs(options) {
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
async function buildBunFallbackDecoder(options) {
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
async function buildBunError(options) {
  const { cwd: pwd, clean } = options;
  const cwd = join(pwd, "packages", "bun-error");
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
async function buildBunNodeFallbacks(options) {
  const { cwd: pwd, clean } = options;
  const cwd = join(pwd, "src", "node-fallbacks");
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

const dependencies = {
  "boringssl": buildBoringSsl,
  "c-ares": buildCares,
  "libarchive": buildLibarchive,
  "libdeflate": buildLibdeflate,
  "libuv": buildLibuv,
  "lol-html": buildLolhtml,
  "ls-hpack": buildLshpack,
  "mimalloc": buildMimalloc,
  "tinycc": buildTinycc,
  "zlib": buildZlib,
  "zstd": buildZstd,
};

/**
 * Builds all dependencies.
 * @param {BuildOptions} options
 */
async function buildDependencies(options) {
  const { os, clean, buildPath } = options;

  if (clean) {
    const depOutPath = join(buildPath, "bun-deps");
    removeFile(depOutPath);
  }

  for (const name of Object.keys(dependencies)) {
    if (name === "libuv" && os !== "windows") {
      continue;
    }
    await buildDependency(name, options);
  }
}

/**
 * Builds a dependency.
 * @param {keyof typeof dependencies} name
 * @param {BuildOptions} options
 */
async function buildDependency(name, options = {}) {
  const dependency = dependencies[name];
  if (!dependency) {
    throw new Error(`Unknown dependency: ${name}`);
  }

  const { cwd, buildPath, clean } = options;
  const depPath = join(cwd, "src", "deps", name);
  const depBuildPath = join(buildPath, name);
  const depOutPath = join(buildPath, "bun-deps");
  const depOptions = {
    ...options,
    artifact: name,
    cwd: depPath,
    buildPath: depBuildPath,
    // TODO: Dependencies have historically been built in release mode.
    // We should change this, but there are various issues with linking.
    debug: false,
  };

  async function build() {
    if (clean) {
      await gitClean(depPath);
      removeFile(depBuildPath);
    }
    await gitCloneSubmodule(depPath, { cwd, force: clean, recursive: true });
    const artifacts = await dependency(depOptions);
    await Promise.all(artifacts.map(upload));
  }

  /**
   * @param {string} artifact
   */
  async function upload(artifact) {
    let path;
    if (isFile(artifact)) {
      path = artifact;
    } else if (isFile(join(depBuildPath, artifact))) {
      path = join(depBuildPath, artifact);
    } else {
      path = join(depBuildPath, artifact);
    }

    if (!isFile(path)) {
      throw new Error(`Artifact not found: ${path}`);
    }

    if (isBuildKite) {
      await buildkiteUploadArtifact(path);
    } else {
      copyFile(path, join(depOutPath, basename(path)));
    }
  }

  await runTask(`Building ${name}`, build);
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildBoringSsl(options) {
  const { os } = options;

  let artifacts;
  if (os === "windows") {
    artifacts = ["crypto.lib", "ssl.lib", "decrepit.lib"];
  } else {
    artifacts = ["libcrypto.a", "libssl.a", "libdecrepit.a"];
  }

  if (isCached(options, artifacts)) {
    return artifacts;
  }

  await cmakeGenerateBuild(options);
  await cmakeBuild(options, ...artifacts);

  return artifacts;
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildCares(options) {
  const { os } = options;

  let artifacts;
  if (os === "windows") {
    artifacts = ["cares.lib"];
  } else {
    artifacts = ["libcares.a"];
  }

  const artifactPaths = artifacts.map(artifact => join("lib", artifact));
  if (isCached(options, artifactPaths)) {
    return artifactPaths;
  }

  await cmakeGenerateBuild(
    { ...options, pic: true },
    "-DCARES_STATIC=ON",
    "-DCARES_STATIC_PIC=ON",
    "-DCARES_SHARED=OFF",
  );
  await cmakeBuild(options, ...artifacts);

  return artifactPaths;
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildLibarchive(options) {
  const { os } = options;

  let artifacts;
  if (os === "windows") {
    artifacts = ["archive.lib"];
  } else {
    artifacts = ["libarchive.a"];
  }

  const artifactPaths = artifacts.map(artifact => join("libarchive", artifact));
  if (isCached(options, artifactPaths)) {
    return artifactPaths;
  }

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

  return artifactPaths;
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildLibdeflate(options) {
  const { os } = options;

  let artifacts;
  if (os === "windows") {
    artifacts = ["deflatestatic.lib"];
  } else {
    artifacts = ["libdeflate.a"];
  }

  if (isCached(options, artifacts)) {
    return artifacts;
  }

  await cmakeGenerateBuild(
    options,
    "-DLIBDEFLATE_BUILD_STATIC_LIB=ON",
    "-DLIBDEFLATE_BUILD_SHARED_LIB=OFF",
    "-DLIBDEFLATE_BUILD_GZIP=OFF",
  );
  await cmakeBuild(options, ...artifacts);

  return artifacts;
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildLibuv(options) {
  const { cwd } = options;

  const artifacts = ["libuv.lib"];
  if (isCached(options, artifacts)) {
    return artifacts;
  }

  await gitClone({
    cwd,
    url: "https://github.com/libuv/libuv",
    commit: "da527d8d2a908b824def74382761566371439003",
  });

  await cmakeGenerateBuild(options, "-DCMAKE_C_FLAGS=/DWIN32 /D_WINDOWS -Wno-int-conversion");
  await cmakeBuild(options);

  return artifacts;
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildLolhtml(options) {
  const { os, cwd, debug } = options;

  let artifacts;
  if (os === "windows") {
    artifacts = ["lolhtml.lib", "lolhtml.pdb"];
  } else {
    artifacts = ["liblolhtml.a"];
  }

  const target = getRustTarget(options);
  const targetPath = join(target, debug ? "debug" : "release");
  const artifactPaths = artifacts.map(artifact => join(targetPath, artifact));
  if (isCached(options, artifactPaths)) {
    return artifactPaths;
  }

  const capiPath = join(cwd, "c-api");
  await cargoBuild({ ...options, cwd: capiPath });

  return artifactPaths;
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildLshpack(options) {
  const { os } = options;

  let artifacts;
  if (os === "windows") {
    artifacts = ["ls-hpack.lib"];
  } else {
    artifacts = ["libls-hpack.a"];
  }

  if (isCached(options, artifacts)) {
    return artifacts;
  }

  await cmakeGenerateBuild(options, "-DLSHPACK_XXH=ON", "-DSHARED=0");
  await cmakeBuild(options, ...artifacts);

  return artifacts;
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildMimalloc(options) {
  const { os, debug, valgrind, buildPath } = options;
  const name = debug ? "libmimalloc-debug" : "libmimalloc";

  let artifacts;
  if (os === "windows") {
    artifacts = ["mimalloc-static.lib"];
  } else {
    artifacts = [`${name}.a`, `${name}.o`];
  }

  if (isCached(options, artifacts)) {
    return artifacts;
  }

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
    flags.push("-DMI_DEBUG=1");
  }
  if (valgrind) {
    flags.push("-DMI_TRACK_VALGRIND=ON");
  }
  await cmakeGenerateBuild(options, ...flags);
  await cmakeBuild(options);

  if (os !== "windows") {
    const objectPath = join(buildPath, "CMakeFiles", "mimalloc-obj.dir", "src", "static.c.o");
    copyFile(objectPath, join(buildPath, `${name}.o`));
  }

  return artifacts;
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildTinycc(options) {
  const { os, cwd, buildPath, cc, ccache, ar, debug, clean, jobs } = options;

  let artifacts;
  if (os === "windows") {
    artifacts = ["tcc.lib"];
  } else {
    artifacts = ["libtcc.a"];
  }

  if (isCached(options, artifacts)) {
    return artifacts;
  }

  // tinycc doesn't support out-of-source builds, so we need to copy the source
  // directory to the build directory.
  if (!isDirectory(buildPath) || clean) {
    removeFile(buildPath);
    copyFile(cwd, buildPath);
  }

  const cflags = getCFlags(options);
  const ldflags = getLdFlags(options);
  const ccOrCcache = ccache ? `${ccache} ${cc}` : cc;

  if (os === "windows") {
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
  } else {
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

  return artifacts;
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildZlib(options) {
  const { os, cwd } = options;

  let artifacts;
  if (os === "windows") {
    artifacts = ["zlib.lib"];
  } else {
    artifacts = ["libz.a"];
  }

  if (isCached(options, artifacts)) {
    return artifacts;
  }

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
  await cmakeBuild(options, ...artifacts);

  return artifacts;
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildZstd(options) {
  const { os, cwd } = options;

  let artifacts;
  if (os === "windows") {
    artifacts = ["zstd_static.lib"];
  } else {
    artifacts = ["libzstd.a"];
  }

  const artifactPaths = artifacts.map(artifact => join("lib", artifact));
  if (isCached(options, artifactPaths)) {
    return artifactPaths;
  }

  const cmakePath = join(cwd, "build", "cmake");
  await cmakeGenerateBuild({ ...options, cwd: cmakePath }, "-DZSTD_BUILD_STATIC=ON");
  await cmakeBuild(options, ...artifacts);

  return artifactPaths;
}

/**
 * Gets whether the artifacts are cached.
 * @param {BuildOptions} options
 * @param {string[]} artifacts
 * @returns {boolean}
 */
function isCached(options, artifacts) {
  const { clean, buildPath } = options;

  if (clean) {
    return false;
  }

  return artifacts
    .map(artifact => join(buildPath, artifact))
    .map(path => isFile(path))
    .every(Boolean);
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
  const { cwd, os, arch, baseline, lto, pic, osxVersion, llvmVersion, artifact } = options;
  const flags = [];

  // Relocates debug info from an absolute path to a relative path
  // https://ccache.dev/manual/4.8.2.html#_compiling_in_different_directories
  if (cwd && os !== "windows") {
    flags.push(`-fdebug-prefix-map=${cwd}=.`);
  }

  if (os === "windows") {
    flags.push("/O2", "/Z7", "/MT", "/Ob2", "/DNDEBUG", "/U_DLL");
  } else {
    flags.push(
      "-O3",
      "-fno-exceptions",
      "-fvisibility=hidden",
      "-fvisibility-inlines-hidden",
      "-mno-omit-leaf-frame-pointer",
      "-fno-omit-frame-pointer",
      "-fno-asynchronous-unwind-tables",
      "-fno-unwind-tables",
    );
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
 * @param {...string} [extraArgs]
 * @returns {string[]}
 */
function getCmakeFlags(options, ...extraArgs) {
  const { cwd, buildPath, debug, os, cc, cxx, ar, ranlib, ld, ccache, osxVersion } = options;

  const cflags = getCFlags(options);
  const cxxflags = getCxxFlags(options);
  const ldflags = getLdFlags(options);

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
    cwd && `-S ${cmakePath(cwd)}`,
    buildPath && `-B ${cmakePath(buildPath)}`,
    "-GNinja",
    cc && `-DCMAKE_C_COMPILER=${cmakePath(cc)}`,
    `-DCMAKE_C_FLAGS=${cflags.join(" ")}`,
    `-DCMAKE_C_STANDARD=17`,
    `-DCMAKE_C_STANDARD_REQUIRED=ON`,
    cxx && `-DCMAKE_CXX_COMPILER=${cmakePath(cxx)}`,
    `-DCMAKE_CXX_FLAGS=${cxxflags.join(" ")}`,
    `-DCMAKE_CXX_STANDARD=20`,
    `-DCMAKE_CXX_STANDARD_REQUIRED=ON`,
    ld && `-DCMAKE_LINKER=${cmakePath(ld)}`,
    `-DCMAKE_LINKER_FLAGS=${ldflags.join(" ")}`,
    ar && `-DCMAKE_AR=${ar}`,
    ranlib && `-DCMAKE_RANLIB=${cmakePath(ranlib)}`,
    ...extraArgs,
  ];

  if (debug) {
    flags.push("-DCMAKE_BUILD_TYPE=Debug");
  } else {
    flags.push("-DCMAKE_BUILD_TYPE=Release");
  }

  if (ccache) {
    flags.push(
      `-DCMAKE_C_COMPILER_LAUNCHER=${cmakePath(ccache)}`,
      `-DCMAKE_CXX_COMPILER_LAUNCHER=${cmakePath(ccache)}`,
    );
  }

  if (os === "linux") {
    // Ensure we always use -std=gnu++20 on Linux
    flags.push("-DCMAKE_CXX_EXTENSIONS=ON");
  } else if (os === "darwin") {
    if (osxVersion) {
      flags.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${osxVersion}`);
    }
  } else if (os === "windows") {
    flags.push("-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded");
  }

  if (isVerbose) {
    flags.push("-DCMAKE_VERBOSE_MAKEFILE=ON", "--log-level=VERBOSE");
  }

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
  const args = getCmakeFlags(options, ...extraArgs);
  await spawn("cmake", args);
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
    args.push("--target", target);
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
    /^(?:PATH|HOME|USER|PWD|TERM)$/i.test(name) ||
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

await main();
