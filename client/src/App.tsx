import { useEffect, useState } from 'react';

export function App() {
  const [status, setStatus] = useState<'checking' | 'ok' | 'down'>('checking');

  useEffect(() => {
    fetch('/health')
      .then((r) => setStatus(r.ok ? 'ok' : 'down'))
      .catch(() => setStatus('down'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Cognition IQ</h1>
      <p>API status: {status}</p>
    </main>
  );
}
