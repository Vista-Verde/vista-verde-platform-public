import {StrictMode,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ExchangeApp} from './ExchangeApp.tsx';
function Standalone(){
  const [csrf,setCsrf]=useState(''),[error,setError]=useState(false);
  useEffect(()=>{let active=true;void fetch('/preview-context',{redirect:'error'}).then(async response=>{if(!response.ok)throw new Error();const value=await response.json();if(active)setCsrf(value.csrf);}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[]);
  return <><p className="exchange-boundary">Independent loopback preview · synthetic local actor · no marketplace database. All tabs share this preview namespace.</p>{error?<p role="alert">Preview unavailable.</p>:csrf?<ExchangeApp csrf={csrf} persona="independent-preview" canSubmit canApprove/>:<p>Opening independent preview…</p>}</>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Standalone/></StrictMode>);
