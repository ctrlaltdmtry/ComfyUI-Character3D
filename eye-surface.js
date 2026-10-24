// Exact +Z-visible surface of the actual posed eye triangles, indexed in projected XY.
// No sphere approximation, eye scaling, texture masks or generated geometry.
export function projectedSurface(positions,indices,nx=64,ny=32){
 let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
 for(let i=0;i<positions.length;i+=3){minX=Math.min(minX,positions[i]);maxX=Math.max(maxX,positions[i]);minY=Math.min(minY,positions[i+1]);maxY=Math.max(maxY,positions[i+1]);}
 const sx=nx/(maxX-minX),sy=ny/(maxY-minY),bins=Array.from({length:nx*ny},()=>[]),triangles=[];
 const cx=x=>Math.max(0,Math.min(nx-1,Math.floor((x-minX)*sx))),cy=y=>Math.max(0,Math.min(ny-1,Math.floor((y-minY)*sy)));
 for(let i=0;i<indices.length;i+=3){
  const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3,ax=positions[a],ay=positions[a+1],bx=positions[b],by=positions[b+1],xx=positions[c],yy=positions[c+1];
  const det=(by-yy)*(ax-xx)+(xx-bx)*(ay-yy);if(Math.abs(det)<1e-14)continue;
  const t={ax,ay,bx,by,cx:xx,cy:yy,az:positions[a+2],bz:positions[b+2],cz:positions[c+2],det};triangles.push(t);
  for(let x=cx(Math.min(ax,bx,xx));x<=cx(Math.max(ax,bx,xx));x++)for(let y=cy(Math.min(ay,by,yy));y<=cy(Math.max(ay,by,yy));y++)bins[y*nx+x].push(t);
 }
 return (x,y)=>{
  if(x<minX-1e-8||x>maxX+1e-8||y<minY-1e-8||y>maxY+1e-8)return undefined;
  let z=-Infinity;for(const t of bins[cy(y)*nx+cx(x)]){const u=((t.by-t.cy)*(x-t.cx)+(t.cx-t.bx)*(y-t.cy))/t.det,v=((t.cy-t.ay)*(x-t.cx)+(t.ax-t.cx)*(y-t.cy))/t.det,w=1-u-v;if(u>=-1e-7&&v>=-1e-7&&w>=-1e-7)z=Math.max(z,u*t.az+v*t.bz+w*t.cz);}
  return z===-Infinity?undefined:z;
 };
}
