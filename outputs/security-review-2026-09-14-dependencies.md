# Security review dependency inventory — 14 September 2026

This is the complete automated advisory inventory supporting the [security review](</Users/mattias/Documents/ChatGPT/Kindle Web Library/outputs/security-review-2026-09-14.md>). **Scanner/component severity is not a demonstrated ShelfSend exploit severity.** The five reproduced application defects are documented in the review.

## Scope and provenance

- Scanner: checksum-verified Anchore Grype 0.118.0; vulnerability database built 2026-09-14T06:38:38Z.
- Current Dockerfile base: `node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`; locally scanned platform: arm64.
- Application image: `kindle-bridge:local`, image ID `sha256:1749294bd084341518f1c6727a752445a84a9d51ba9c6f75c605cb79a1a427d0`, built 4 September 2026. Its advisory/package/version match set was identical to the separately scanned pinned base.
- Observed runtime: Node 24.20.0, OpenSSL 3.5.7, V8 13.6.233.17-node.53, libuv 1.52.1.
- Project `npm audit --json --ignore-scripts`: zero reported vulnerabilities in the current lockfile. Global npm inside the base image is a different dependency tree.
- Vendored Cargo source: `third_party/boko/Cargo.lock`; inventory includes development and build dependencies, not only dependencies emitted into browser WASM.

## Container advisory matches

There are 227 package/advisory matches and 107 distinct advisory IDs. Grouping below retains every matching component and version. Duplicate binary packages from one Debian source package do not represent independent flaws.

| Upstream severity | Package/advisory matches | Distinct advisory IDs |
| --- | ---: | ---: |
| Critical | 7 | 6 |
| High | 56 | 24 |
| Medium | 72 | 35 |
| Low | 10 | 7 |
| Negligible | 58 | 29 |
| Unknown | 24 | 6 |

The fix column reports scanner data, not a claim that every affected function is shipped or used. `wont-fix` is the distribution advisory state; it does not by itself prove exploitability. `not-fixed` means the feed supplies no fixed version. Some matches have architecture or privileged-operation prerequisites that do not hold for the documented non-root, capability-dropped deployment.

Runtime reachability assessment: ShelfSend starts with `node dist/server/main.js`. It does not import the global npm dependency tree or invoke Perl, mount/nsenter, or PCRE2 as part of normal HTTP/book processing. Their advisory triggers were not demonstrated through the app. Node’s JavaScript regular expressions use V8, and Node’s built-in fetch must not be confused with the separate npm-owned undici package. These installed components still deserve patch/minimization review.

| Advisory | Upstream severity | Installed matching components | Fixed version / feed state |
| --- | --- | --- | --- |
| [CVE-2026-12087](https://security-tracker.debian.org/tracker/CVE-2026-12087) | Critical | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2026-13221](https://security-tracker.debian.org/tracker/CVE-2026-13221) | Critical | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2026-42496](https://security-tracker.debian.org/tracker/CVE-2026-42496) | Critical | `perl-base 5.36.0-7+deb12u3` | wont-fix |
| [CVE-2026-5450](https://security-tracker.debian.org/tracker/CVE-2026-5450) | Critical | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | wont-fix |
| [CVE-2026-57433](https://security-tracker.debian.org/tracker/CVE-2026-57433) | Critical | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2026-8376](https://security-tracker.debian.org/tracker/CVE-2026-8376) | Critical | `perl-base 5.36.0-7+deb12u3` | wont-fix |
| [CVE-2025-13151](https://security-tracker.debian.org/tracker/CVE-2025-13151) | High | `libtasn1-6 4.19.0-2+deb12u1` | wont-fix |
| [CVE-2025-69720](https://security-tracker.debian.org/tracker/CVE-2025-69720) | High | `libtinfo6 6.4-4`<br>`ncurses-base 6.4-4`<br>`ncurses-bin 6.4-4` | wont-fix |
| [CVE-2026-41992](https://security-tracker.debian.org/tracker/CVE-2026-41992) | High | `gzip 1.12-1` | wont-fix |
| [CVE-2026-42497](https://security-tracker.debian.org/tracker/CVE-2026-42497) | High | `perl-base 5.36.0-7+deb12u3` | wont-fix |
| [CVE-2026-48959](https://security-tracker.debian.org/tracker/CVE-2026-48959) | High | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2026-48962](https://security-tracker.debian.org/tracker/CVE-2026-48962) | High | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2026-5435](https://security-tracker.debian.org/tracker/CVE-2026-5435) | High | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | wont-fix |
| [CVE-2026-54369](https://security-tracker.debian.org/tracker/CVE-2026-54369) | High | `libacl1 2.3.1-3` | wont-fix |
| [CVE-2026-54370](https://security-tracker.debian.org/tracker/CVE-2026-54370) | High | `libacl1 2.3.1-3` | wont-fix |
| [CVE-2026-57432](https://security-tracker.debian.org/tracker/CVE-2026-57432) | High | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2026-5928](https://security-tracker.debian.org/tracker/CVE-2026-5928) | High | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | wont-fix |
| [CVE-2026-7017](https://security-tracker.debian.org/tracker/CVE-2026-7017) | High | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2026-76642](https://security-tracker.debian.org/tracker/CVE-2026-76642) | High | `bsdutils 1:2.38.1-5+deb12u3`<br>`libblkid1 2.38.1-5+deb12u3`<br>`libmount1 2.38.1-5+deb12u3`<br>`libsmartcols1 2.38.1-5+deb12u3`<br>`libuuid1 2.38.1-5+deb12u3`<br>`mount 2.38.1-5+deb12u3`<br>`util-linux 2.38.1-5+deb12u3`<br>`util-linux-extra 2.38.1-5+deb12u3` | not-fixed |
| [CVE-2026-78408](https://security-tracker.debian.org/tracker/CVE-2026-78408) | High | `bsdutils 1:2.38.1-5+deb12u3`<br>`libblkid1 2.38.1-5+deb12u3`<br>`libmount1 2.38.1-5+deb12u3`<br>`libsmartcols1 2.38.1-5+deb12u3`<br>`libuuid1 2.38.1-5+deb12u3`<br>`mount 2.38.1-5+deb12u3`<br>`util-linux 2.38.1-5+deb12u3`<br>`util-linux-extra 2.38.1-5+deb12u3` | not-fixed |
| [CVE-2026-78409](https://security-tracker.debian.org/tracker/CVE-2026-78409) | High | `bsdutils 1:2.38.1-5+deb12u3`<br>`libblkid1 2.38.1-5+deb12u3`<br>`libmount1 2.38.1-5+deb12u3`<br>`libsmartcols1 2.38.1-5+deb12u3`<br>`libuuid1 2.38.1-5+deb12u3`<br>`mount 2.38.1-5+deb12u3`<br>`util-linux 2.38.1-5+deb12u3`<br>`util-linux-extra 2.38.1-5+deb12u3` | not-fixed |
| [CVE-2026-78410](https://security-tracker.debian.org/tracker/CVE-2026-78410) | High | `bsdutils 1:2.38.1-5+deb12u3`<br>`libblkid1 2.38.1-5+deb12u3`<br>`libmount1 2.38.1-5+deb12u3`<br>`libsmartcols1 2.38.1-5+deb12u3`<br>`libuuid1 2.38.1-5+deb12u3`<br>`mount 2.38.1-5+deb12u3`<br>`util-linux 2.38.1-5+deb12u3`<br>`util-linux-extra 2.38.1-5+deb12u3` | not-fixed |
| [CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091) | High | `zlib1g 1:1.2.13.dfsg-1` | not-fixed |
| [CVE-2026-86145](https://security-tracker.debian.org/tracker/CVE-2026-86145) | High | `libpcre2-8-0 10.42-1` | 10.42-1+deb12u1 |
| [CVE-2026-89161](https://security-tracker.debian.org/tracker/CVE-2026-89161) | High | `libpcre2-8-0 10.42-1` | 10.42-1+deb12u1 |
| [CVE-2026-9538](https://security-tracker.debian.org/tracker/CVE-2026-9538) | High | `perl-base 5.36.0-7+deb12u3` | wont-fix |
| [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | High | `brace-expansion 5.0.7` | 5.0.8 |
| [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr) | High | `ip-address 10.2.0` | 10.3.1 |
| [GHSA-r292-9mhp-454m](https://github.com/advisories/GHSA-r292-9mhp-454m) | High | `tar 7.5.19` | 7.5.21 |
| [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) | High | `brace-expansion 5.0.7` | 5.0.9 |
| [CVE-2023-50495](https://security-tracker.debian.org/tracker/CVE-2023-50495) | Medium | `libtinfo6 6.4-4`<br>`ncurses-base 6.4-4`<br>`ncurses-bin 6.4-4` | wont-fix |
| [CVE-2024-10041](https://security-tracker.debian.org/tracker/CVE-2024-10041) | Medium | `libpam-modules 1.5.2-6+deb12u2`<br>`libpam-modules-bin 1.5.2-6+deb12u2`<br>`libpam-runtime 1.5.2-6+deb12u2`<br>`libpam0g 1.5.2-6+deb12u2` | wont-fix |
| [CVE-2025-15649](https://security-tracker.debian.org/tracker/CVE-2025-15649) | Medium | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2025-30258](https://security-tracker.debian.org/tracker/CVE-2025-30258) | Medium | `gpgv 2.2.40-1.1+deb12u2` | wont-fix |
| [CVE-2025-6141](https://security-tracker.debian.org/tracker/CVE-2025-6141) | Medium | `libtinfo6 6.4-4`<br>`ncurses-base 6.4-4`<br>`ncurses-bin 6.4-4` | wont-fix |
| [CVE-2025-68972](https://security-tracker.debian.org/tracker/CVE-2025-68972) | Medium | `gpgv 2.2.40-1.1+deb12u2` | wont-fix |
| [CVE-2026-13595](https://security-tracker.debian.org/tracker/CVE-2026-13595) | Medium | `bsdutils 1:2.38.1-5+deb12u3`<br>`libblkid1 2.38.1-5+deb12u3`<br>`libmount1 2.38.1-5+deb12u3`<br>`libsmartcols1 2.38.1-5+deb12u3`<br>`libuuid1 2.38.1-5+deb12u3`<br>`mount 2.38.1-5+deb12u3`<br>`util-linux 2.38.1-5+deb12u3`<br>`util-linux-extra 2.38.1-5+deb12u3` | not-fixed |
| [CVE-2026-13757](https://security-tracker.debian.org/tracker/CVE-2026-13757) | Medium | `libp11-kit0 0.24.1-2` | wont-fix |
| [CVE-2026-15059](https://security-tracker.debian.org/tracker/CVE-2026-15059) | Medium | `libsystemd0 252.39-1~deb12u2`<br>`libudev1 252.39-1~deb12u2` | wont-fix |
| [CVE-2026-15534](https://security-tracker.debian.org/tracker/CVE-2026-15534) | Medium | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2026-16742](https://security-tracker.debian.org/tracker/CVE-2026-16742) | Medium | `libsystemd0 252.39-1~deb12u2`<br>`libudev1 252.39-1~deb12u2` | wont-fix |
| [CVE-2026-18374](https://security-tracker.debian.org/tracker/CVE-2026-18374) | Medium | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | wont-fix |
| [CVE-2026-18477](https://security-tracker.debian.org/tracker/CVE-2026-18477) | Medium | `tar 1.34+dfsg-1.2+deb12u1` | wont-fix |
| [CVE-2026-18508](https://security-tracker.debian.org/tracker/CVE-2026-18508) | Medium | `tar 1.34+dfsg-1.2+deb12u1` | wont-fix |
| [CVE-2026-18938](https://security-tracker.debian.org/tracker/CVE-2026-18938) | Medium | `libp11-kit0 0.24.1-2` | wont-fix |
| [CVE-2026-19487](https://security-tracker.debian.org/tracker/CVE-2026-19487) | Medium | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2026-27171](https://security-tracker.debian.org/tracker/CVE-2026-27171) | Medium | `zlib1g 1:1.2.13.dfsg-1` | wont-fix |
| [CVE-2026-27456](https://security-tracker.debian.org/tracker/CVE-2026-27456) | Medium | `bsdutils 1:2.38.1-5+deb12u3`<br>`libblkid1 2.38.1-5+deb12u3`<br>`libmount1 2.38.1-5+deb12u3`<br>`libsmartcols1 2.38.1-5+deb12u3`<br>`libuuid1 2.38.1-5+deb12u3`<br>`mount 2.38.1-5+deb12u3`<br>`util-linux 2.38.1-5+deb12u3`<br>`util-linux-extra 2.38.1-5+deb12u3` | wont-fix |
| [CVE-2026-3184](https://security-tracker.debian.org/tracker/CVE-2026-3184) | Medium | `bsdutils 1:2.38.1-5+deb12u3`<br>`libblkid1 2.38.1-5+deb12u3`<br>`libmount1 2.38.1-5+deb12u3`<br>`libsmartcols1 2.38.1-5+deb12u3`<br>`libuuid1 2.38.1-5+deb12u3`<br>`mount 2.38.1-5+deb12u3`<br>`util-linux 2.38.1-5+deb12u3`<br>`util-linux-extra 2.38.1-5+deb12u3` | wont-fix |
| [CVE-2026-41991](https://security-tracker.debian.org/tracker/CVE-2026-41991) | Medium | `gzip 1.12-1` | wont-fix |
| [CVE-2026-42250](https://security-tracker.debian.org/tracker/CVE-2026-42250) | Medium | `libbz2-1.0 1.0.8-5+b1` | wont-fix |
| [CVE-2026-54371](https://security-tracker.debian.org/tracker/CVE-2026-54371) | Medium | `libattr1 1:2.5.1-4` | wont-fix |
| [CVE-2026-54411](https://security-tracker.debian.org/tracker/CVE-2026-54411) | Medium | `libpam-modules 1.5.2-6+deb12u2`<br>`libpam-modules-bin 1.5.2-6+deb12u2`<br>`libpam-runtime 1.5.2-6+deb12u2`<br>`libpam0g 1.5.2-6+deb12u2` | wont-fix |
| [CVE-2026-5704](https://security-tracker.debian.org/tracker/CVE-2026-5704) | Medium | `tar 1.34+dfsg-1.2+deb12u1` | wont-fix |
| [CVE-2026-6238](https://security-tracker.debian.org/tracker/CVE-2026-6238) | Medium | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | wont-fix |
| [CVE-2026-6791](https://security-tracker.debian.org/tracker/CVE-2026-6791) | Medium | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | wont-fix |
| [CVE-2026-7010](https://security-tracker.debian.org/tracker/CVE-2026-7010) | Medium | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2026-89092](https://security-tracker.debian.org/tracker/CVE-2026-89092) | Medium | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | not-fixed |
| [CVE-2026-89157](https://security-tracker.debian.org/tracker/CVE-2026-89157) | Medium | `libpcre2-8-0 10.42-1` | 10.42-1+deb12u1 |
| [CVE-2026-89158](https://security-tracker.debian.org/tracker/CVE-2026-89158) | Medium | `libpcre2-8-0 10.42-1` | 10.42-1+deb12u1 |
| [GHSA-22jq-vg5j-6vgg](https://github.com/advisories/GHSA-22jq-vg5j-6vgg) | Medium | `ip-address 10.2.0` | 10.2.1 |
| [GHSA-4xrf-jv44-h6hh](https://github.com/advisories/GHSA-4xrf-jv44-h6hh) | Medium | `ip-address 10.2.0` | 10.2.2 |
| [GHSA-8xcm-r25x-g524](https://github.com/advisories/GHSA-8xcm-r25x-g524) | Medium | `undici 6.27.0` | 6.28.0 |
| [GHSA-m8rv-5g2x-5cg5](https://github.com/advisories/GHSA-m8rv-5g2x-5cg5) | Medium | `undici 6.27.0` | 6.28.0 |
| [GHSA-v3r7-h72x-cjcm](https://github.com/advisories/GHSA-v3r7-h72x-cjcm) | Medium | `undici 6.27.0` | 6.28.0 |
| [CVE-2016-2781](https://security-tracker.debian.org/tracker/CVE-2016-2781) | Low | `coreutils 9.1-1` | wont-fix |
| [CVE-2024-56433](https://security-tracker.debian.org/tracker/CVE-2024-56433) | Low | `login 1:4.13+dfsg1-1+deb12u2`<br>`passwd 1:4.13+dfsg1-1+deb12u2` | wont-fix |
| [CVE-2026-40228](https://security-tracker.debian.org/tracker/CVE-2026-40228) | Low | `libsystemd0 252.39-1~deb12u2`<br>`libudev1 252.39-1~deb12u2` | wont-fix |
| [CVE-2026-57062](https://security-tracker.debian.org/tracker/CVE-2026-57062) | Low | `gpgv 2.2.40-1.1+deb12u2` | wont-fix |
| [CVE-2026-6368](https://security-tracker.debian.org/tracker/CVE-2026-6368) | Low | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | wont-fix |
| [CVE-2026-89156](https://security-tracker.debian.org/tracker/CVE-2026-89156) | Low | `libpcre2-8-0 10.42-1` | 10.42-1+deb12u1 |
| [CVE-2026-89160](https://security-tracker.debian.org/tracker/CVE-2026-89160) | Low | `libpcre2-8-0 10.42-1` | 10.42-1+deb12u1 |
| [CVE-2005-2541](https://security-tracker.debian.org/tracker/CVE-2005-2541) | Negligible | `tar 1.34+dfsg-1.2+deb12u1` | not-fixed |
| [CVE-2007-5686](https://security-tracker.debian.org/tracker/CVE-2007-5686) | Negligible | `login 1:4.13+dfsg1-1+deb12u2`<br>`passwd 1:4.13+dfsg1-1+deb12u2` | not-fixed |
| [CVE-2010-4756](https://security-tracker.debian.org/tracker/CVE-2010-4756) | Negligible | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | not-fixed |
| [CVE-2011-3374](https://security-tracker.debian.org/tracker/CVE-2011-3374) | Negligible | `apt 2.6.1`<br>`libapt-pkg6.0 2.6.1` | not-fixed |
| [CVE-2011-3389](https://security-tracker.debian.org/tracker/CVE-2011-3389) | Negligible | `libgnutls30 3.7.9-2+deb12u7` | not-fixed |
| [CVE-2011-4116](https://security-tracker.debian.org/tracker/CVE-2011-4116) | Negligible | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2013-4392](https://security-tracker.debian.org/tracker/CVE-2013-4392) | Negligible | `libsystemd0 252.39-1~deb12u2`<br>`libudev1 252.39-1~deb12u2` | not-fixed |
| [CVE-2017-18018](https://security-tracker.debian.org/tracker/CVE-2017-18018) | Negligible | `coreutils 9.1-1` | not-fixed |
| [CVE-2018-20796](https://security-tracker.debian.org/tracker/CVE-2018-20796) | Negligible | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | not-fixed |
| [CVE-2018-6829](https://security-tracker.debian.org/tracker/CVE-2018-6829) | Negligible | `libgcrypt20 1.10.1-3+deb12u1` | not-fixed |
| [CVE-2019-1010022](https://security-tracker.debian.org/tracker/CVE-2019-1010022) | Negligible | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | not-fixed |
| [CVE-2019-1010023](https://security-tracker.debian.org/tracker/CVE-2019-1010023) | Negligible | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | not-fixed |
| [CVE-2019-1010024](https://security-tracker.debian.org/tracker/CVE-2019-1010024) | Negligible | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | not-fixed |
| [CVE-2019-1010025](https://security-tracker.debian.org/tracker/CVE-2019-1010025) | Negligible | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | not-fixed |
| [CVE-2019-9192](https://security-tracker.debian.org/tracker/CVE-2019-9192) | Negligible | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | not-fixed |
| [CVE-2022-0563](https://security-tracker.debian.org/tracker/CVE-2022-0563) | Negligible | `bsdutils 1:2.38.1-5+deb12u3`<br>`libblkid1 2.38.1-5+deb12u3`<br>`libmount1 2.38.1-5+deb12u3`<br>`libsmartcols1 2.38.1-5+deb12u3`<br>`libuuid1 2.38.1-5+deb12u3`<br>`mount 2.38.1-5+deb12u3`<br>`util-linux 2.38.1-5+deb12u3`<br>`util-linux-extra 2.38.1-5+deb12u3` | not-fixed |
| [CVE-2022-27943](https://security-tracker.debian.org/tracker/CVE-2022-27943) | Negligible | `gcc-12-base 12.2.0-14+deb12u1`<br>`libgcc-s1 12.2.0-14+deb12u1`<br>`libstdc++6 12.2.0-14+deb12u1` | not-fixed |
| [CVE-2022-3219](https://security-tracker.debian.org/tracker/CVE-2022-3219) | Negligible | `gpgv 2.2.40-1.1+deb12u2` | not-fixed |
| [CVE-2023-31437](https://security-tracker.debian.org/tracker/CVE-2023-31437) | Negligible | `libsystemd0 252.39-1~deb12u2`<br>`libudev1 252.39-1~deb12u2` | not-fixed |
| [CVE-2023-31438](https://security-tracker.debian.org/tracker/CVE-2023-31438) | Negligible | `libsystemd0 252.39-1~deb12u2`<br>`libudev1 252.39-1~deb12u2` | not-fixed |
| [CVE-2023-31439](https://security-tracker.debian.org/tracker/CVE-2023-31439) | Negligible | `libsystemd0 252.39-1~deb12u2`<br>`libudev1 252.39-1~deb12u2` | not-fixed |
| [CVE-2023-31486](https://security-tracker.debian.org/tracker/CVE-2023-31486) | Negligible | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2024-2236](https://security-tracker.debian.org/tracker/CVE-2024-2236) | Negligible | `libgcrypt20 1.10.1-3+deb12u1` | not-fixed |
| [CVE-2025-14104](https://security-tracker.debian.org/tracker/CVE-2025-14104) | Negligible | `bsdutils 1:2.38.1-5+deb12u3`<br>`libblkid1 2.38.1-5+deb12u3`<br>`libmount1 2.38.1-5+deb12u3`<br>`libsmartcols1 2.38.1-5+deb12u3`<br>`libuuid1 2.38.1-5+deb12u3`<br>`mount 2.38.1-5+deb12u3`<br>`util-linux 2.38.1-5+deb12u3`<br>`util-linux-extra 2.38.1-5+deb12u3` | not-fixed |
| [CVE-2025-5278](https://security-tracker.debian.org/tracker/CVE-2025-5278) | Negligible | `coreutils 9.1-1` | not-fixed |
| [CVE-2026-48961](https://security-tracker.debian.org/tracker/CVE-2026-48961) | Negligible | `perl-base 5.36.0-7+deb12u3` | not-fixed |
| [CVE-2026-53910](https://security-tracker.debian.org/tracker/CVE-2026-53910) | Negligible | `diffutils 1:3.8-4` | not-fixed |
| [CVE-2026-56391](https://security-tracker.debian.org/tracker/CVE-2026-56391) | Negligible | `coreutils 9.1-1` | not-fixed |
| [CVE-2026-56392](https://security-tracker.debian.org/tracker/CVE-2026-56392) | Negligible | `coreutils 9.1-1` | not-fixed |
| [CVE-2026-19499](https://security-tracker.debian.org/tracker/CVE-2026-19499) | Unknown | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | wont-fix |
| [CVE-2026-19542](https://security-tracker.debian.org/tracker/CVE-2026-19542) | Unknown | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | wont-fix |
| [CVE-2026-53613](https://security-tracker.debian.org/tracker/CVE-2026-53613) | Unknown | `bsdutils 1:2.38.1-5+deb12u3`<br>`libblkid1 2.38.1-5+deb12u3`<br>`libmount1 2.38.1-5+deb12u3`<br>`libsmartcols1 2.38.1-5+deb12u3`<br>`libuuid1 2.38.1-5+deb12u3`<br>`mount 2.38.1-5+deb12u3`<br>`util-linux 2.38.1-5+deb12u3`<br>`util-linux-extra 2.38.1-5+deb12u3` | not-fixed |
| [CVE-2026-53615](https://security-tracker.debian.org/tracker/CVE-2026-53615) | Unknown | `bsdutils 1:2.38.1-5+deb12u3`<br>`libblkid1 2.38.1-5+deb12u3`<br>`libmount1 2.38.1-5+deb12u3`<br>`libsmartcols1 2.38.1-5+deb12u3`<br>`libuuid1 2.38.1-5+deb12u3`<br>`mount 2.38.1-5+deb12u3`<br>`util-linux 2.38.1-5+deb12u3`<br>`util-linux-extra 2.38.1-5+deb12u3` | not-fixed |
| [CVE-2026-77117](https://security-tracker.debian.org/tracker/CVE-2026-77117) | Unknown | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | wont-fix |
| [CVE-2026-80489](https://security-tracker.debian.org/tracker/CVE-2026-80489) | Unknown | `libc-bin 2.36-9+deb12u14`<br>`libc6 2.36-9+deb12u14` | wont-fix |

## Cargo lockfile matches

Both matches concern one Low-severity advisory with a custom-logger prerequisite. The lockfile paths are `phf_generator → rand 0.8.5` and development dependency `proptest → rand 0.9.2`. No runtime browser exploit was established. Updating the lockfile/build toolchain is a maintenance task; scanner presence alone does not justify claiming that the generated WASM is vulnerable.

| Advisory | Upstream severity | Locked versions | Patched versions |
| --- | --- | --- | --- |
| [GHSA-cq8v-f236-94qc](https://github.com/advisories/GHSA-cq8v-f236-94qc) | Low | rand 0.8.5, rand 0.9.2 | 0.8.6, 0.9.3 |

## Evidence limits

No base image rebuild, package update, live-service exploit test, or device operation was performed. Upstream version/fix matches should be rechecked when hardening because advisory feeds change. The inventory is a dated record, not a guarantee that all statically bundled Node/OpenSSL/V8 code or every feature-specific dependency was recognized by the scanner.
