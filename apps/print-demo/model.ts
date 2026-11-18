// Browser-only metadata and local simulation. No file, destination or approval
// from this model is submitted to the shared domain, persisted or logged.
export const MAX_STL_BYTES = 10 * 1024 * 1024;
export const MAX_STL_TRIANGLES = 100_000;
export type Mesh = { format:'binary'|'ascii';triangles:number;bounds:[number,number,number];synthetic:boolean };
export type Units = ''|'mm'|'inch';
export type PrintTerms = { units:Units;material:'petg'|'resin'|'wide';source:'producer'|'customer';customerAccepted:boolean;quantity:string;printBudget:string;deliveryBudget:string;deadlineDays:string;zone:'A'|'B';notes:string };
export type Stage = 'draft'|'print_approved'|'delivery_approved'|'printing'|'dispatched'|'delivered'|'acknowledged';
export const defaults:PrintTerms = {units:'',material:'petg',source:'producer',customerAccepted:false,quantity:'1',printBudget:'30.00',deliveryBudget:'10.00',deadlineDays:'7',zone:'A',notes:''};
export const stages:Stage[] = ['draft','print_approved','delivery_approved','printing','dispatched','delivered','acknowledged'];

export function inspectStl(buffer:ArrayBuffer):Mesh {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_STL_BYTES) throw new Error('STL must be nonempty and no larger than 10 MiB.');
  const view = new DataView(buffer);
  const minima = [Infinity,Infinity,Infinity],maxima = [-Infinity,-Infinity,-Infinity];
  const vertex = (values:number[]) => values.forEach((value,axis) => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e7) throw new Error('STL contains nonfinite or out-of-range coordinates.');
    minima[axis] = Math.min(minima[axis]!,value);maxima[axis] = Math.max(maxima[axis]!,value);
  });
  let triangles = 0,format:'binary'|'ascii';
  // Exact binary length wins even if the untrusted header begins with "solid".
  const binaryCount = buffer.byteLength >= 84 ? view.getUint32(80,true) : 0;
  if (buffer.byteLength >= 84 && 84+50*binaryCount === buffer.byteLength) {
    if (!binaryCount || binaryCount > MAX_STL_TRIANGLES) throw new Error('STL requires 1–100,000 triangles.');
    format = 'binary';triangles = binaryCount;
    for (let triangle=0;triangle<triangles;triangle++) {
      const offset = 84+50*triangle;
      for (let axis=0;axis<3;axis++) if (!Number.isFinite(view.getFloat32(offset+axis*4,true))) throw new Error('STL contains an invalid normal.');
      for (let point=0;point<3;point++) vertex([0,1,2].map(axis => view.getFloat32(offset+12+point*12+axis*4,true)));
    }
  } else {
    // Tokenized strict grammar; avoid unbounded regex matching or accepting a
    // partial file. Names at the first/last line are ignored, never retained.
    let text:string;
    try { text = new TextDecoder('utf-8',{fatal:true}).decode(buffer); } catch { throw new Error('STL is truncated or is neither supported binary nor ASCII.'); }
    const lines = text.trim().split(/\r?\n/);
    if (!/^solid(?:\s.*)?$/.test(lines.shift() ?? '') || !/^endsolid(?:\s.*)?$/.test(lines.pop() ?? '')) throw new Error('ASCII STL needs complete solid / endsolid boundaries.');
    const tokens = lines.join(' ').trim().split(/\s+/),number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
    let cursor = 0;
    const word = (expected:string) => { if (tokens[cursor++] !== expected) throw new Error('Malformed ASCII STL facet.'); };
    const point = () => [0,1,2].map(() => { const token=tokens[cursor++] ?? '';if (!number.test(token)) throw new Error('Invalid ASCII STL number.');const value=Number(token);if (!Number.isFinite(value)) throw new Error('Invalid ASCII STL number.');return value; });
    while (cursor<tokens.length) {
      if (++triangles > MAX_STL_TRIANGLES) throw new Error('STL requires 1–100,000 triangles.');
      word('facet');word('normal');point();word('outer');word('loop');
      for (let i=0;i<3;i++) { word('vertex');vertex(point()); }
      word('endloop');word('endfacet');
    }
    if (!triangles) throw new Error('STL requires 1–100,000 triangles.');
    format = 'ascii';
  }
  return {format,triangles,bounds:[0,1,2].map(axis => maxima[axis]!-minima[axis]!) as [number,number,number],synthetic:false};
}

export function syntheticCube():ArrayBuffer {
  const corners = [[0,0,0],[20,0,0],[20,20,0],[0,20,0],[0,0,20],[20,0,20],[20,20,20],[0,20,20]];
  const faces = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const buffer = new ArrayBuffer(84+50*faces.length),view=new DataView(buffer);view.setUint32(80,faces.length,true);
  faces.forEach((face,i) => face.forEach((corner,j) => corners[corner]!.forEach((value,axis) => view.setFloat32(84+i*50+12+j*12+axis*4,value,true))));
  return buffer;
}
export const fixtureMesh = ():Mesh => ({...inspectStl(syntheticCube()),synthetic:true});
export function minorUnits(value:string):number|undefined {
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(value)) return;
  const [whole,cents=''] = value.split('.');return Number(whole)*100+Number(cents.padEnd(2,'0'));
}
export const usd = (minor:number) => `$${(minor/100).toFixed(2)}`;
export function quote(mesh:Mesh|undefined,terms:PrintTerms) {
  const issues:string[] = [],quantity=/^\d+$/.test(terms.quantity) ? Number(terms.quantity) : 0;
  const printBudget=minorUnits(terms.printBudget),deliveryBudget=minorUnits(terms.deliveryBudget);
  const deadline=/^\d+$/.test(terms.deadlineDays) ? Number(terms.deadlineDays) : 0;
  const dimensions = mesh && terms.units ? mesh.bounds.map(value => value*(terms.units === 'inch' ? 25.4 : 1)) : undefined;
  const unitPrice=terms.source === 'producer' ? 3000 : 2600,printTotal=unitPrice*quantity,delivery=terms.zone === 'A' ? 1000 : 1800,arrivalDay=terms.zone === 'A' ? 6 : 9;
  if (!mesh) issues.push('Select a local STL or load the labeled synthetic cube.');
  if (!terms.units) issues.push('Confirm the STL coordinate unit; STL does not declare units.');
  if (dimensions && dimensions.some((size,axis) => size<=0 || size>[220,220,250][axis]!)) issues.push('Bounds do not fit the mock 220 × 220 × 250 mm build envelope.');
  if (terms.material !== 'petg') issues.push('Mock printer accepts only the demo FDM / PETG / 1.75 mm profile.');
  if (!Number.isSafeInteger(quantity) || quantity<1 || quantity>10) issues.push('Choose a counted quantity of 1–10 parts.');
  if (printBudget === undefined || printBudget<printTotal) issues.push('Print budget must cover the synthetic all-in print quote.');
  if (deliveryBudget === undefined || deliveryBudget<delivery) issues.push('Delivery allowance must cover the separate mock courier quote.');
  if (deadline<arrivalDay || deadline>30) issues.push(`In-hand deadline must allow the mock arrival on day ${arrivalDay} (maximum 30 days).`);
  if (terms.source === 'customer' && !terms.customerAccepted) issues.push('Customer material needs explicit mock producer acceptance of this profile.');
  return {issues,dimensions,quantity,unitPrice,printTotal,delivery,total:printTotal+delivery,materialContribution:terms.source === 'producer' ? 400*quantity : 0,arrivalDay};
}
export function advance(stage:Stage,event:'approve_print'|'approve_delivery'|'produce'|'dispatch'|'deliver'|'acknowledge',valid:boolean):Stage {
  if (!valid) throw new Error('Resolve the specification, compatibility and budget checks first.');
  const transitions = {approve_print:['draft','print_approved'],approve_delivery:['print_approved','delivery_approved'],produce:['delivery_approved','printing'],dispatch:['printing','dispatched'],deliver:['dispatched','delivered'],acknowledge:['delivered','acknowledged']} as const;
  const [from,to] = transitions[event];if (stage!==from) throw new Error('The next explicit checkpoint is required.');return to;
}
