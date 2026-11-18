import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { MarketApp } from './market/MarketApp.tsx';
import { WebClient,PendingStore } from './client.ts';
// Lazy storage access lets the UI report blocked storage without failing at import.
const storage = {
  getItem:(key:string) => sessionStorage.getItem(key),
  setItem:(key:string,value:string) => sessionStorage.setItem(key,value),
  removeItem:(key:string) => sessionStorage.removeItem(key)
};
const Workspace = /^\/legacy(?:\/|$)/.test(window.location.pathname) ? App : MarketApp;
const profile=Workspace === MarketApp ? 'vista-verde-work-orders.v0.3':undefined;
createRoot(document.getElementById('root')!).render(<StrictMode><Workspace client={new WebClient()} store={new PendingStore(storage,profile)}/></StrictMode>);
