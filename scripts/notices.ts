import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
const root=resolve('.'),target=join(root,'third-party-licenses');mkdirSync(target,{recursive:true});
const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));
const rows:string[]=[];
for(const [path,value] of Object.entries(lock.packages) as [string,{name?:string;version?:string;license?:string;dev?:boolean}][]){
  if(!path||!value.version)continue;
  const name=value.name??path.replace(/^.*node_modules\//,'');const license=value.license??'See packaged notice';
  rows.push(`| ${name} | ${value.version} | ${license} | ${value.dev?'Build/test':'Runtime'} |`);
  const dir=join(root,path);if(!existsSync(dir))continue;
  for(const file of readdirSync(dir)){if(!/^(LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i.test(file))continue;try{const body=readFileSync(join(dir,file),'utf8');writeFileSync(join(target,`${name.replaceAll('/','__').replaceAll('@','')}-${value.version}-${basename(file)}.txt`),body);}catch{}}
}
writeFileSync(join(root,'THIRD-PARTY-NOTICES.md'),`# Third-party notices\n\nBillable source is MIT licensed. This inventory comes from the exact package-lock.json used for the release. Dependency license texts from installed packages are bundled in third-party-licenses/. Native SQLite is public domain. Fonts (Young Serif and Schibsted Grotesk) are bundled locally through Fontsource; their SIL Open Font License notices are included. No third-party illustrations, remote fonts or analytics are loaded at runtime.\n\n| Package | Version | License | Use |\n| --- | --- | --- | --- |\n${rows.sort().join('\n')}\n\nIndirect dependencies are included for attribution. This inventory does not assert that the app replaces those projects or their legal terms.\n`);
console.log(`Generated notices for ${rows.length} pinned packages.`);
