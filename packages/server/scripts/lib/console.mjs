const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = c("2");
const green = c("32");
const red = c("31");
const yellow = c("33");

export function info(msg) { console.log(`${dim("==>")} ${msg}`); }
export function ok(msg) { console.log(`${green("OK")}  ${msg}`); }
export function warn(msg) { console.warn(`${yellow("!!")}  ${msg}`); }
export function fail(msg) { console.error(`${red("FAIL")} ${msg}`); }
