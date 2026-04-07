'use client';

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { WaitlistModal } from './WaitlistModal';

type WaitlistContextValue = {
  open: () => void;
};

const WaitlistModalContext = createContext<WaitlistContextValue>({
  open: () => {},
});

export function useWaitlistModal() {
  return useContext(WaitlistModalContext);
}

export function WaitlistModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openModal = useCallback(() => setOpen(true), []);
  const closeModal = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ open: openModal }), [openModal]);

  return (
    <WaitlistModalContext.Provider value={value}>
      {children}
      <WaitlistModal open={open} onClose={closeModal} />
    </WaitlistModalContext.Provider>
  );
}
