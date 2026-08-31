import * as React from 'react';

/**
 * Shared state for the mobile sidebar drawer. The sidebar is rendered once in
 * the root layout (persistent on desktop, overlay on mobile), but the header
 * hamburger button lives in both the root Stack header and the tab navigator
 * header, so both need to toggle the same state.
 */
interface SidebarContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const SidebarContext = React.createContext<SidebarContextValue>({
  open: false,
  setOpen: () => {},
});

export const useSidebar = () => React.useContext(SidebarContext);

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return <SidebarContext.Provider value={{ open, setOpen }}>{children}</SidebarContext.Provider>;
}
