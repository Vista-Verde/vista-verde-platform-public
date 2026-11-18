const mode=process.argv[2];
if (!['live','ready'].includes(mode ?? '')) process.exit(1);
try {
  const response=await fetch(`http://127.0.0.1:4318/health/${mode}`,{ signal:AbortSignal.timeout(2000) });
  if (!response.ok) process.exitCode=1;
} catch { process.exitCode=1; }
