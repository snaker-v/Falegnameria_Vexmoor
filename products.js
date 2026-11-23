export const categories = {
  casse:['Casse e bauli','Custodia e trasporto per la bottega, la casa e il viaggio.'],
  attrezzi:['Attrezzi','Utensili per il lavoro quotidiano di artigiani e lavoratori.'],
  legname:['Legname e materiali','Materiali da banco per lavorazioni e riparazioni.'],
  equipaggiamento:['Equipaggiamento','Dotazioni per il viaggio, il campo e il lavoro all’aperto.'],
  strutture:['Strutture','Manufatti per sistemare e attrezzare spazi di lavoro.'],
  accessori:['Accessori','Articoli di servizio per la bottega e per la casa.'],
};
export function category(name) {
  const n=name.toLocaleLowerCase('it');
  if (/^(cassa|baule)/.test(n) && !n.startsWith('cassaforte')) return 'casse';
  if (/ascia|pala|mortaio|tagliatore|coltello/.test(n)) return 'attrezzi';
  if (/^assi|^carbone|^legno|^ferro$|^acciaio$|^lingotto|^chiodo|^argento/.test(n)) return 'legname';
  if (/zaino|tenda|torcia/.test(n)) return 'equipaggiamento';
  if (/staccionata|canaletta|banco|carriola/.test(n)) return 'strutture';
  return 'accessori';
}
export const catalogImages = Object.freeze({
  "ascia": "catalog-images/01.webp",
  "assi di legno": "catalog-images/02.webp",
  "assi di legno pregiato": "catalog-images/03.webp",
  "cassa sotterrabile": "catalog-images/04.webp",
  "zaino piccolo": "catalog-images/05.webp",
  "portachiavi": "catalog-images/06.webp",
  "carbone": "catalog-images/07.webp",
  "pala": "catalog-images/08.webp",
  "staccionata": "catalog-images/09.webp",
  "canaletta piccola": "catalog-images/10.webp",
  "secchio pepite": "catalog-images/11.webp",
  "secchio acqua": "catalog-images/12.webp",
  "mortaio": "catalog-images/13.webp",
  "tagliatore di gemme": "catalog-images/14.webp",
  "coltello da intaglio": "catalog-images/15.webp",
  "banco da lavoro": "catalog-images/16.webp",
  "cassa piccola chiusa": "catalog-images/17.webp",
  "freezer": "catalog-images/18.webp",
  "zaino medio": "catalog-images/19.webp",
  "ascia migliorata": "catalog-images/20.webp",
  "carriola smontata": "catalog-images/21.webp",
  "tenda piccola": "catalog-images/22.webp",
  "torcia": "catalog-images/23.webp",
  "cassa piccola treno smontata": "catalog-images/24.webp",
  "canaletta grande": "catalog-images/25.webp",
  "cassa media chiusa": "catalog-images/26.webp",
  "ascia di ferro": "catalog-images/27.webp",
  "baule grande": "catalog-images/28.webp",
  "tenda grande": "catalog-images/29.webp",
  "cassa media treno smontata": "catalog-images/30.webp",
  "zaino grande": "catalog-images/31.webp",
  "cassa grande chiusa": "catalog-images/32.webp",
  "ascia di acciaio": "catalog-images/33.webp",
  "cassa grande treno smontata": "catalog-images/34.webp",
  "cassaforte 160 kg": "catalog-images/35.webp",
  "cassaforte grande 500 kg": "catalog-images/36.webp"
});
export const photo = (name,id=name.toLocaleLowerCase('it'))=>'/'+(Object.hasOwn(catalogImages,id)?catalogImages[id]:category(name)+'.webp');
export const euro = cents=>cents==null?'Su preventivo':new Intl.NumberFormat('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2}).format(cents)+' $';
