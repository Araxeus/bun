#!/usr/bin/env node

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
  mkdir,
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
  uploadArtifact,
} from "./util.mjs";

/**
 * @typedef {Object} BuildOptions
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
 * @property {string} [cwd]
 * @property {string} [buildPath]
 * @property {string} [clean]
 * @property {string} [artifact]
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
    defaultValue: debug ? false : true,
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
    defaultValue: isCI,
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
  });

  const buildPath = getOption({
    name: "build",
    description: "The build directory",
    defaultValue: () => join("build", debug ? "debug" : "release", target),
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
  };

  const args = process.argv.slice(2).filter(arg => !arg.startsWith("-"));

  const print = getOption({
    name: "print",
    description: "Print the options and exit",
    type: "boolean",
  });

  if (print) {
    console.log("Options:", options);
    console.log("Args:", args);
    process.exit(0);
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
export async function buildBun(options, target) {
  const { cwd, buildPath: basePath } = options;
  
  const depsPath = resolve(basePath, "bun-deps");
  const zigPath = resolve(basePath, "bun-zig", "bun-zig.o");
  const cppPath = resolve(basePath, "bun-cpp", "bun-cpp-objects.a");

  const buildPath = resolve(basePath, target ? `bun-${target}` : "bun-build");
  const buildOptions = {
    ...options,
    artifact: "bun",
    build: buildPath,
  };

  const cleanPath = target ? basePath : buildPath;
  if (clean || !isDirectory(cleanPath)) {
    removeFile(cleanPath);
  }

  if (target === "cpp") {
    flags.push("-DBUN_CPP_ONLY=ON");
  } else if (target === "zig") {
    const zigTarget = getZigTarget(options);
    flags.push("-DWEBKIT_DIR=omit", `-DBUN_ZIG_OBJ_DIR=${bunZigPath}`, `-DZIG_TARGET=${zigTarget}`);
  } else if (target === "link") {
    flags.push("-DBUN_LINK_ONLY=1", `-DBUN_CPP_ARCHIVE=${bunCppPath}`, `-DBUN_ZIG_OBJ_DIR=${bunZigPath}`);
  }

  if (!target || target === "zig") {
    await buildBunOldJs(options);
  }

  await cmakeGenerateBuild(buildOptions, ...flags);

  if (target) {
    const args = ["-j", `${jobs}`];
    if (verbose) {
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
 * Gets the extra cmake flags for building bun.
 * @param {BuildOptions} options 
 */
function getBunCmakeFlags(options) {
  const { baseline, lto, valgrind, assertions, canary, isBuild, buildNumber } = options;
  const flags = ["-DNO_CONFIGURE_DEPENDS=ON"];

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

  return flags;
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
      [
        "esbuild",
        "--bundle",
        "--minify",
        "--format=esm",
        "--platform=browser",
        `--outdir=${outPath}`,
        ...filenames,
      ],
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
export async function buildDependencies(options) {
  const { clean, buildPath } = options;

  if (clean) {
    const depOutPath = join(buildPath, "bun-deps");
    removeFile(depOutPath);
  }

  for (const name of Object.keys(dependencies)) {
    await buildDependency(name, options);
  }
}

/**
 * Builds a dependency.
 * @param {keyof typeof dependencies} name
 * @param {BuildOptions} options
 */
export async function buildDependency(name, options = {}) {
  const dependency = dependencies[name];
  if (!dependency) {
    throw new Error(`Unknown dependency: ${name}`);
  }

  const { cwd, buildPath, clean } = options;
  const pwd = cwd || process.cwd();
  const depPath = join(pwd, "src", "deps", name);
  const depBuildPath = join(pwd, buildPath, name);
  const depOutPath = join(pwd, buildPath, "bun-deps");
  const depOptions = {
    ...options,
    artifact: name,
    cwd: depPath,
    buildPath: depBuildPath,
    // FIXME: Figure out linking issues when dependencies are built in debug mode.
    debug: false,
  };

  async function build() {
    if (clean) {
      await gitClean(depPath);
      removeFile(depBuildPath);
    }
    await gitCloneSubmodule(depPath, { cwd, force: clean, recursive: true });
    return dependency(depOptions);
  }

  const artifacts = await runTask(`Building ${name}`, build);

  /**
   * @param {string} artifact 
   */
  async function upload(artifact) {
    let path;
    if (isFile(artifact)) {
      path = artifact;
    } else {
      path = join(depBuildPath, artifact);
    }

    if (!isFile(path)) {
      throw new Error(`Artifact not found: ${path}`);
    }

    if (isCI) {
      uploadArtifact(path);
    } else {
      copyFile(path, join(depOutPath, basename(path)));
    }
  }

  await runTask(`Saving ${name}`, () => Promise.all(artifacts.map(upload)));
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

  await cmakeGenerateBuild(
    { ...options, pic: true },
    "-DCARES_STATIC=ON",
    "-DCARES_STATIC_PIC=ON",
    "-DCARES_SHARED=OFF",
  );
  await cmakeBuild(options, ...artifacts);

  return artifacts.map(artifact => join("lib", artifact));
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

  return artifacts.map(artifact => join("libarchive", artifact));
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
  const { os, cwd } = options;

  if (os !== "windows") {
    return [];
  }

  await gitClone({
    cwd,
    url: "https://github.com/libuv/libuv",
    commit: "da527d8d2a908b824def74382761566371439003",
  });

  await cmakeGenerateBuild(options, "-DCMAKE_C_FLAGS=/DWIN32 /D_WINDOWS -Wno-int-conversion");
  await cmakeBuild(options);

  return ["libuv.lib"];
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildLolhtml(options) {
  const { os, cwd } = options;

  let artifacts;
  if (os === "windows") {
    artifacts = ["lolhtml.lib", "lolhtml.pdb"];
  } else {
    artifacts = ["liblolhtml.a"];
  }

  const capiPath = join(cwd, "c-api");
  const targetPath = await cargoBuild({ ...options, cwd: capiPath });

  return artifacts.map(artifact => join(targetPath, artifact));
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
    const { stdout: revision } = spawnSync("git", ["rev-parse", "HEAD"], { cwd: buildPath });
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
    return ["tcc.lib"];
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
    return ["libtcc.a"];
  }
}

/**
 * @param {BuildOptions} options
 * @returns {Promise<string[]>}
 */
async function buildZlib(options) {
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

  let artifacts;
  if (os === "windows") {
    artifacts = ["zlib.lib"];
  } else {
    artifacts = ["libz.a"];
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

  const cmakePath = join(cwd, "build", "cmake");
  await cmakeGenerateBuild({ ...options, cwd: cmakePath }, "-DZSTD_BUILD_STATIC=ON");
  await cmakeBuild(options, ...artifacts);

  return artifacts.map(artifact => join("lib", artifact));
}

/**
 * Gets the C flags for the given options.
 * @param {BuildOptions} options
 * @returns {string[]}
 */
export function getCFlags(options) {
  const { os, arch, baseline, lto, pic, osxVersion, llvmVersion, artifact } = options;
  const flags = [];
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
    if (compareSemver(llvmVersion, "18") >= 0 && artifact === "zlib") {
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
export function getCxxFlags(options) {
  const { os, lto, artifact } = options;
  const flags = getCFlags(options);
  if (os !== "windows") {
    flags.push("-fno-rtti", "-fno-c++-static-destructors");
    if (lto) {
      flags.push("-fwhole-program-vtables", "-fforce-emit-vtables");
    }
  }
  // Fixes build issue with libc++ on macOS 13.0:
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
export function getLdFlags(options) {
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
export function getCmakeFlags(options) {
  const { cwd, buildPath, debug, os, cc, cxx, ar, ranlib, ld, ccache, osxVersion } = options;

  const cflags = getCFlags(options);
  const cxxflags = getCxxFlags(options);
  const ldflags = getLdFlags(options);

  const flags = [
    cwd && `-S ${cwd}`,
    buildPath && `-B ${buildPath}`,
    "-GNinja",
    cc && `-DCMAKE_C_COMPILER=${cc}`,
    `-DCMAKE_C_FLAGS=${cflags.join(" ")}`,
    `-DCMAKE_C_STANDARD=17`,
    `-DCMAKE_C_STANDARD_REQUIRED=ON`,
    cxx && `-DCMAKE_CXX_COMPILER=${cxx}`,
    `-DCMAKE_CXX_FLAGS=${cxxflags.join(" ")}`,
    `-DCMAKE_CXX_STANDARD=20`,
    `-DCMAKE_CXX_STANDARD_REQUIRED=ON`,
    ld && `-DCMAKE_LINKER=${ld}`,
    `-DCMAKE_LINKER_FLAGS=${ldflags.join(" ")}`,
    ar && `-DCMAKE_AR=${ar}`,
    ranlib && `-DCMAKE_RANLIB=${ranlib}`,
  ];

  if (debug) {
    flags.push("-DCMAKE_BUILD_TYPE=Debug");
  } else {
    flags.push("-DCMAKE_BUILD_TYPE=Release");
  }

  if (ccache) {
    flags.push(`-DCMAKE_C_COMPILER_LAUNCHER=${ccache}`, `-DCMAKE_CXX_COMPILER_LAUNCHER=${ccache}`);
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
 * Runs CMake to generate the build files.
 * @param {BuildOptions} options
 * @param {...string} extraArgs
 */
export async function cmakeGenerateBuild(options, ...extraArgs) {
  const args = getCmakeFlags(options);

  await spawn("cmake", [...args, ...extraArgs]);
}

/**
 * Runs CMake to build the project.
 * @param {BuildOptions} options
 * @param {string[]} [targets]
 */
export async function cmakeBuild(options, ...targets) {
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
 * @returns {Promise<string>}
 */
export async function cargoBuild(options) {
  const { cwd, buildPath, debug, jobs } = options;

  const target = getRustTarget(options);
  const targetPath = buildPath || join(cwd, "build");
  const args = ["build", "--target-dir", targetPath, "--target", target, "--jobs", `${jobs}`];
  if (!debug) {
    args.push("--release");
  }
  if (isVerbose) {
    args.push("--verbose");
  }
  await spawn("cargo", args, { cwd });

  return join(targetPath, target, debug ? "debug" : "release");
}

/**
 * Gets the Rust target for the given options.
 * @param {BuildOptions} options
 * @returns {string}
 */
export function getRustTarget(options) {
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
export function getZigTarget(options) {
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

if (new URL(import.meta.url).pathname === process.argv[1]) {
  await main();
}
