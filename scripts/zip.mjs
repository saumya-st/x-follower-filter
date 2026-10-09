import { execSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("release", { recursive: true });
const out = `release/x-follower-filter-${pkg.version}.zip`;
// PowerShell Compress-Archive is available on every Windows box; tar works elsewhere.
if (process.platform === "win32") {
  execSync(`powershell -NoProfile -Command "Compress-Archive -Force -Path dist\* -DestinationPath ${out}"`, { stdio: "inherit" });
} else {
  execSync(`cd dist && zip -r ../${out} .`, { stdio: "inherit" });
}
console.log("wrote", out);
