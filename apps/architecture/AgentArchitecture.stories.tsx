import type{Meta,StoryObj}from'@storybook/react-vite';
import{expect}from'storybook/test';
import{AgentArchitecture}from'./components.tsx';
import'./style.css';
const meta={title:'Architecture/Agents operate, humans supervise',component:AgentArchitecture,parameters:{layout:'fullscreen'}}satisfies Meta<typeof AgentArchitecture>;
export default meta;
type Story=StoryObj<typeof meta>;
export const Overview:Story={play:async({canvas,canvasElement})=>{
  await expect(canvas.getByRole('heading',{name:'Agents operate. Humans supervise.'})).toBeVisible();
  await expect(canvas.getByRole('img',{name:/Agents operate, humans supervise/})).toBeVisible();
  await expect(canvas.getByRole('region',{name:'Architecture text equivalent'})).toBeVisible();
  await expect(canvas.getByRole('list',{name:'Diagram legend'})).toBeVisible();
  await expect(canvas.getByText(/does not implement a universal human-approval policy/)).toBeVisible();
  await expect(canvas.getByText(/No public MCP endpoint is exposed/)).toBeVisible();
  await expect(canvas.queryAllByRole('button')).toHaveLength(0);
  const document=canvasElement.ownerDocument;
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
}};
