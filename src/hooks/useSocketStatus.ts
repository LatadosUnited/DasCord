import { useEffect, useRef, useState } from 'react';
import { realtimeSocket } from '../services/socket';

/** Se o servidor está no ar agora. `onDisconnect` limpa o que não sobrevive à queda. */
export function useSocketStatus(onDisconnect: () => void): boolean {
  const [serverOnline, setServerOnline] = useState(false);
  const onDisconnectRef = useRef(onDisconnect);
  useEffect(() => {
    onDisconnectRef.current = onDisconnect;
  }, [onDisconnect]);

  useEffect(
    () =>
      realtimeSocket.subscribeStatus((connected) => {
        setServerOnline(connected);
        if (!connected) onDisconnectRef.current();
      }),
    []
  );

  return serverOnline;
}
