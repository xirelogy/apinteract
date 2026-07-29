const response = await fetch("http://127.0.0.1:8080/health", {
  signal: AbortSignal.timeout(3000),
});
if (!response.ok) {
  process.exitCode = 1;
} else {
  const health = await response.json();
  if (health.status !== "ready") {
    process.exitCode = 1;
  }
}
