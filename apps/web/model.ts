import type { Success } from '../../packages/contracts/src/index.ts';
import type { Workspace, WorkspaceRecord, SlotView, RequirementView } from '../../packages/contracts/src/views.ts';
import type { Session } from './client.ts';
import { WebClient } from './client.ts';
export type AuditEvent = { operation: string; actorId: string; organizationId: string; happenedAt: string; reason: string };
export type PageData =
  | { kind:'listing'; mode:'slots'|'records'; slots:SlotView[]; records:WorkspaceRecord[]; cursor:string|null; commitments:boolean }
  | { kind:'draft' }
  | { kind:'requirement'; id:string; response:Success; view:RequirementView; audit:AuditEvent[] }
  | { kind:'slot'; slot:SlotView; view:RequirementView; audit:AuditEvent[] }
  | { kind:'commitment'; id:string; receipt:Success; slot:SlotView; view:RequirementView; audit:AuditEvent[] }
  | { kind:'missingSlot' };
export type View = { key:string; csrf:string; workspace?:Workspace; page?:PageData; error?:Error };
type NavigationStorage = Pick<Storage,'getItem'|'setItem'>;
export async function loadView(client: WebClient,session: Session,hash: string,key: string,storage: NavigationStorage): Promise<View> {
  let workspace: Workspace | undefined;
  try {
    workspace = (await client.call(session,'getWorkspace',{})).data as unknown as Workspace;
    const [route,id,reference] = hash.slice(1).split('/').map(decodeURIComponent);
    const audit = async (requirementId: string) => (await client.call(session,'getScopedAudit',{ requirementId,limit:20 })).data.events as AuditEvent[];
    const remember = (slots: SlotView[]) => { for (const slot of slots) storage.setItem(`vv.slot.${slot.slotId}`,slot.requirementId); };
    let page: PageData;
    if (route === 'requirement' && id) {
      const response = await client.call(session,'getRequirement',{ requirementId:id });
      page = { kind:'requirement',id,response,view:response.data as unknown as RequirementView,audit:await audit(id) };
    } else if (route === 'slot' && id) {
      let list = await client.call(session,'listAvailableSlots',{ limit:100 });
      let slots = list.data.slots as unknown as SlotView[];
      while (!slots.some(slot => slot.slotId === id) && list.data.nextCursor) {
        list = await client.call(session,'listAvailableSlots',{ cursor:list.data.nextCursor,limit:100 });
        slots = list.data.slots as unknown as SlotView[];
      }
      let slot = slots.find(value => value.slotId === id);
      const known = reference ?? storage.getItem(`vv.slot.${id}`);
      if (!slot && known) {
        const response = await client.call(session,'getRequirement',{ requirementId:known });
        slot = (response.data as unknown as RequirementView).slots.find(value => value.slotId === id);
      }
      if (!slot) page = { kind:'missingSlot' };
      else {
        remember([slot]);
        const response = await client.call(session,'getRequirement',{ requirementId:slot.requirementId });
        const view = response.data as unknown as RequirementView;
        slot = view.slots.find(value => value.slotId === id);
        if (!slot) throw new Error('This slot is no longer in the current authorized requirement.');
        page = { kind:'slot',slot,view,audit:await audit(slot.requirementId) };
      }
    } else if (route === 'commitment' && id) {
      const receipt = await client.call(session,'getCommitment',{ commitmentId:id });
      const response = await client.call(session,'getRequirement',{ requirementId:receipt.recordIds.requirementId });
      const view = response.data as unknown as RequirementView;
      const slot = view.slots.find(value => value.slotId === receipt.recordIds.slotId);
      if (!slot) throw new Error('The current authorized commitment view is unavailable.');
      page = { kind:'commitment',id,receipt,slot,view,audit:await audit(slot.requirementId) };
    } else if (route === 'draft' && workspace.role === 'buyer_agent') page = { kind:'draft' };
    else if (workspace.role === 'producer' && route !== 'commitments') {
      const response = await client.call(session,'listAvailableSlots',{ limit:20 });
      const slots = response.data.slots as unknown as SlotView[]; remember(slots);
      page = { kind:'listing',mode:'slots',slots,records:[],cursor:response.data.nextCursor as string|null,commitments:false };
    } else page = { kind:'listing',mode:'records',slots:[],records:workspace.records,cursor:workspace.nextCursor,commitments:workspace.role === 'producer' };
    return { key,csrf:session.csrf,workspace,page };
  } catch (error) { return { key,csrf:session.csrf,workspace,error:error as Error }; }
}
