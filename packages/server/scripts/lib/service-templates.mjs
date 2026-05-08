function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderLaunchdPlist(ctx) {
  const envEntries = Object.entries(ctx.env)
    .map(([k, v]) => `    <key>${escapeXml(k)}</key><string>${escapeXml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(ctx.serviceName)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(ctx.nodeBin)}</string>
    <string>${escapeXml(ctx.entryPoint)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(ctx.workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(ctx.stdoutLog)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(ctx.stderrLog)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(ctx) {
  const envLines = Object.entries(ctx.env)
    .map(([k, v]) => `Environment="${k}=${v}"`)
    .join("\n");
  return `[Unit]
Description=${ctx.description}
After=network.target

[Service]
Type=simple
ExecStart=${ctx.nodeBin} ${ctx.entryPoint}
WorkingDirectory=${ctx.workingDir}
${envLines}
Restart=always
RestartSec=10
StandardOutput=append:${ctx.stdoutLog}
StandardError=append:${ctx.stderrLog}

[Install]
WantedBy=default.target
`;
}
