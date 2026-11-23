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
export const photo = name=>'/'+category(name)+'.webp';
export const euro = cents=>cents==null?'Su preventivo':new Intl.NumberFormat('it-IT',{minimumFractionDigits:2,maximumFractionDigits:2}).format(cents)+' $';
