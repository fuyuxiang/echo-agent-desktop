// Decode only the provider's observed array wrapper. This is audit code, not an executor.
export function nativeModifiers(value) {
 if(value===undefined)return [];
 for(let depth=0;depth<2;depth++){if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&'item' in value)value=value.item;else break;}
 if(Array.isArray(value))return value;
 if(typeof value==='string')return [value];
 return null;
}
export function nativeShortcut(args={}) {
 const modifiers=nativeModifiers(args.modifiers);
 const keyChord=typeof args.key==='string'&&args.key.includes('+')&&args.modifiers===undefined;
 const parts=typeof args.shortcut==='string'?args.shortcut.split('+'):(keyChord?args.key.split('+'):(modifiers&&typeof args.key==='string'&&!args.key.includes('+')?[...modifiers,args.key]:[]));
 if(!parts.length||parts.some(p=>typeof p!=='string'))return '';
 const canonical=parts.map(p=>{const v=p.trim().toLowerCase();return {command:'cmd',meta:'cmd',control:'ctrl',option:'alt'}[v]||v;});
 const key=canonical.pop();if(!key||canonical.some(m=>!['cmd','ctrl','alt','shift'].includes(m)))return '';
 return [...['cmd','ctrl','alt','shift'].filter(m=>canonical.includes(m)),key].join('+');
}

export function nativeBrowserMarkerObserved(tools,marker,identifier='com.apple.Safari') {
 const windows=new Set();
 for(const t of tools){const s=t.output?.state||t.output;if(s?.identifier!==identifier)continue;if(s.windowRef)windows.add(s.windowRef);for(const w of s.windows||[])windows.add(w.ref);}
 return tools.some(t=>{const s=t.output?.state||t.output;if(!s||(s.identifier!==identifier&&!windows.has(s.windowRef)))return false;
  return (s.windows||[]).some(w=>w.name?.includes(marker))||(s.nodes||[]).some(n=>
   (n.role==='AXStaticText'&&n.value===marker)||(['AXWebArea','AXWindow'].includes(n.role)&&n.name?.includes(marker)));
 });
}
