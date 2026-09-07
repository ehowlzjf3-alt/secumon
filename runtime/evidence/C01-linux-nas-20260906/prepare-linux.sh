#!/bin/sh
set -eu
task_root=/home/shaneee/secumon-linux-test.pCJ0bd
cd "$task_root"
umask 077
test "$(stat -c %a .)" = 700
printf '%s\n' 'ee22f5ab8b9beebd2d9ff81098daac03bb4d8362182cb5816ef28eca406a4e0a  runtime-source.tar.gz' | sha256sum -c -
curl --fail --silent --show-error --location --connect-timeout 15 --max-time 180 https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz -o node-v24.20.0-linux-x64.tar.xz
printf '%s\n' '2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2  node-v24.20.0-linux-x64.tar.xz' | sha256sum -c -
mkdir -m 700 runtime tmp npm-cache evidence
tar -xJf node-v24.20.0-linux-x64.tar.xz
tar -xzf runtime-source.tar.gz -C runtime
export PATH="$task_root/node-v24.20.0-linux-x64/bin:/usr/bin:/bin"
export TMPDIR="$task_root/tmp"
: > "$task_root/empty.npmrc"
cd runtime
npm --userconfig "$task_root/empty.npmrc" --cache "$task_root/npm-cache" ci --ignore-scripts --no-audit --no-fund > "$task_root/evidence/npm-ci.log" 2>&1
node --version
npm --version
