# Embedded runtime notice sources

`manifest.json` binds notice text to the exact npm versions in the esbuild bundle
and native versions in `android-node.lock.json`. Builds verify the vendored text
SHA-256 values and copy shared notices once per upstream project. Both the
package inventories and source/version/hash records ship under `licenses/`.
The two packages copied outside esbuild, quickjs-wasi and photon-node, also enter
that inventory. Their existing package LICENSE files are copied to `licenses/npm`
and checked against the exact version and text hashes in the same manifest.

Only license and notice text is vendored here. The data-uri-to-buffer text is the
unchanged License section of its version's upstream README. standardwebhooks
uses `libraries/LICENSE`, which covers its JavaScript library; the repository
root's Apache license covers different material.

The Node copyright file already contains OpenSSL 3.6.5's complete license body.
The build verifies this against the vendored official text while ignoring
indentation and whitespace, and records the existing packaged file instead of
copying a second license body. OpenSSL's release has no separate root NOTICE.

The libc++ binary is stripped by Termux, so its full hash differs from the NDK
binary. Both have GNU ELF build ID `48896bc02543d915439f872cc76d2a751e62fd98`.
The notice is the unmodified LLVM NOTICE from the official NDK r30 archive,
including libc++, libc++abi, compiler_rt and LLVM exceptions. This is not the
archive's aggregate `NOTICE.toolchain` containing unrelated tool licenses.

The CA bundle is byte-identical to the dated curl release recorded in the
manifest. SQLite's exact release supplies its public-domain and build-file
explanation. `resolv-conf` is a locked extraction dependency, but the build
copies none of its configuration into the APK; its native inventory has no
artifacts. These records describe packaged files and source provenance, not a
legal opinion about distribution.
