// G1.1 and G1.2: the builder in two languages. DOM-free except `applyLang`, which takes the document
// it writes to, with textContent and setAttribute only. index.html keeps English as the fallback.
export type Lang = 'es' | 'en'
export const LANG_KEY = 'lamppost.lang'

// A stored choice wins; then the phone's language (any es*); then English.
export const pickLang = (navLang: string | undefined, stored: string | null): Lang =>
  stored === 'es' || stored === 'en' ? stored : /^es\b/i.test(navLang ?? '') ? 'es' : 'en'

// Storage comes as a getter: when site data is blocked, even reading `window.localStorage`
// throws, not just getItem. Neither of these may ever throw. main.ts reads every startup value
// through `load`, so a blocked storage cannot stop the page halfway.
const local = () => localStorage
export const load = (key: string, storage: () => Storage = local): string | null => {
  try { return storage().getItem(key) } catch { return null }
}
export const keep = (key: string, value: string, storage: () => Storage = local) => {
  try { storage().setItem(key, value) } catch {} // blocked: the choice holds for this page load
}

// needs-native-review: plain Spanish written by the lab, not yet read by a native speaker.
// One short sentence per `es` entry, no jargon (no signer, bunker, NIP-07, relay, nsec).
export const STRINGS: Record<string, { en: string; es: string }> = {
  title: { en: 'Lamppost — add an item', es: 'Lamppost — agrega un artículo' },
  brand: { en: 'Lamppost', es: 'Lamppost' },
  lede: { en: 'Author a yard-sale item. It is signed by your own signer, its photo goes to Blossom, its offer is minted on your own node over CLINK, and the listing goes to public relays. Nothing here has a server of ours behind it.', es: 'Pon a la venta algo de tu venta de garaje, sin ningún servidor nuestro de por medio.' },
  'lang.other': { en: 'Español', es: 'English' },
  's1.h': { en: '1 · Your signer', es: '1 · Tu app de firma' },
  's1.hint': { en: 'Nothing in this app ever sees your key. It asks your signer to sign, and your signer decides.', es: 'Esta app nunca ve tu clave secreta, y tu app de firma decide qué se firma.' },
  's1.nip07': { en: 'Browser extension (NIP-07)', es: 'Extensión del navegador' },
  's1.scan': { en: 'Connect a bunker — one approval', es: 'Conectar tu app de firma con un solo permiso' },
  's1.paste': { en: '…or paste a', es: '…o pega un enlace' },
  's1.pasteTail': { en: 'URL or a NIP-05', es: 'o tu dirección, como tú@ejemplo.com' },
  's1.placeholder': { en: 'bunker://… or you@example.com', es: 'Pega aquí tu enlace o tu dirección' },
  's1.connect': { en: 'Connect', es: 'Conectar' },
  's1.as': { en: 'Signed in as', es: 'Conectado como' },
  's1.disconnect': { en: 'Disconnect', es: 'Desconectar' },
  // #34: written by main.ts. The es drops {label}: it is a technical name such as "NIP-07 extension".
  'status.connected': { en: 'Connected via {label}.', es: 'Conectado.' },
  whoami: { en: '{label} — {key}', es: '{key}' },
  // #69: the es never shows {msg}, the raw English error a seller cannot act on in Spanish (G2.1).
  'status.waiting': { en: 'Waiting for your signer…', es: 'Esperando a tu app de firma…' },
  'status.scan': { en: 'Scan the code with your signer. Approve every permission it lists.', es: 'Escanea el código con tu app de firma y acepta todos los permisos.' },
  'status.connectFail': { en: '{msg}', es: 'No se pudo conectar. Revisa tu app de firma e inténtalo otra vez.' },
  'shrink.hint': { en: 'A kind 30405 is a replacement: publishing this list is what un-lists the rest, because nostr has no “remove one item” event. Un-listing is not deleting — those listings stay on the relays and your storefront still draws them, at the foot of the page and out of the sale’s order. And this is exactly what deliberately retiring an item looks like, which is why nobody can tell the two apart for you.', es: 'Al publicar esta lista, los demás artículos dejan de estar en la venta. Quitarlos no es borrarlos: siguen en tu tienda, al final de la página. Así se ve también quitar algo a propósito, y por eso solo tú sabes si fue tu intención.' },
  'shrink.ok': { en: 'Yes, un-list them. I meant to.', es: 'Sí, quítalos de la venta. Lo quiero así.' },
  'price.hint': { en: 'Sats only. There is no currency conversion anywhere in this app — that would need a price oracle, and an oracle is somebody else’s server. Price something in pesos by leaving the node field empty: it lists, it just has no Buy button.', es: 'Solo en sats. Esta app no convierte monedas. Para poner un precio en pesos, deja vacío el campo del nodo: el artículo se publica, pero sin botón de Comprar.' },
  'price.fiatNote': { en: 'This item was priced in another currency, so it keeps that price and stays cash at the table — no Buy button, no offer on your node, whatever the node field says. You can change the amount. You cannot change the currency here, and nothing in this app converts one to the other.', es: 'Este artículo tiene precio en otra moneda, así que se paga en efectivo y no tiene botón de Comprar. Puedes cambiar la cantidad, pero aquí no puedes cambiar la moneda. Esta app no convierte monedas.' },
  // #60: panel 5's static text. `items.reload` has no HTML text: main.ts sets it after a load.
  'panel5.h': { en: '5 · Your sale so far', es: '5 · Tu venta hasta ahora' },
  'panel5.hint': { en: 'Read straight off the public relays with no credential at all — the same events any visitor sees, which is why this list can exist in a page that holds no key.', es: 'Esta lista se lee de los servidores públicos, igual que la ve cualquier visitante de tu tienda.' },
  'items.load': { en: 'Load my items', es: 'Ver mis artículos' },
  'items.reload': { en: 'Reload my items', es: 'Volver a cargar mis artículos' },
  'notes.save': { en: 'Save my private notes', es: 'Guardar mis notas privadas' },
  'notes.hint': { en: 'Notes are encrypted to your own key and published as one event. Nobody else can read them — not a relay, not us, not a buyer. Nothing of ours stores them either; they live on the same relays as the sale, which is why they survive you closing this tab.', es: 'Solo tú puedes leer tus notas, ni nosotros ni los compradores. Se guardan junto a tu venta, así que siguen ahí si cierras esta página.' },
  // #74: panel 5's sentences that main.ts writes itself, and panel 7. `{sale}` is items.sale or items.noSale.
  'items.reading': { en: 'reading the relays…', es: 'leyendo tu tienda…' },
  'items.loaded': { en: '{n} item(s), read from {ok}/{all} relays · {sale}', es: '{n} artículo(s), leídos de {ok}/{all} servidores · {sale}' },
  'items.sale': { en: 'sale “{title}”', es: 'venta “{title}”' },
  'items.noSale': { en: 'no sale published yet — section 3', es: 'aún no publicas tu venta, ve a la sección 3' },
  'items.otherCurrency': { en: 'Priced in something this form cannot carry, so republishing it here would change what it says.', es: 'Su precio está en algo que este formulario no maneja. Si lo publicas aquí, cambiaría lo que dice.' },
  'items.otherSale': { en: 'Published outside “{d}”, so this form cannot address it without orphaning the original.', es: 'Se publicó fuera de “{d}”. Aquí no se puede cambiar sin dejar suelto el original.' },
  'note.label': { en: 'Private note', es: 'Nota privada' },
  'note.placeholder': { en: 'What you paid for it. Who is coming to collect it. What to say if they haggle.', es: 'Cuánto pagaste. Quién viene por él. Qué decir si regatean.' },
  'stickers.cost': { en: '0 signatures. {n} unsold item(s) get a sticker; sold ones do not, because the thing is gone.', es: 'No tienes que aprobar nada. {n} artículo(s) sin vender llevan etiqueta. Los vendidos no, porque ya no están.' },
  'notes.cost': { en: '1 signature, however many notes you changed — they are one encrypted event, not one each.', es: 'Lo apruebas una sola vez, aunque cambies muchas notas. Se guardan todas juntas.' },
  'deployed.live': { en: 'Your sale is live at', es: 'Tu venta ya está en línea en' },
  'deploy.detail': { en: '{n} files on {s} Blossom server(s), manifest on {ok}/{all} relays. Site version {v}…. The first request may time out while the gateway fetches the blobs — reload once.', es: '{n} archivos en {s} servidor(es) de archivos y {ok}/{all} servidores con el índice. Versión del sitio {v}…. La primera visita puede tardar. Si falla, vuelve a cargar una vez.' },
}

// The keys with no non-empty `es`. The inventory test (G1.1) fails on any of these.
export const missing = (keys: string[], table: Record<string, { en: string; es?: string }> = STRINGS) =>
  keys.filter(k => !table[k]?.es?.trim())

// A table text with each {name} replaced. An unknown key falls back to itself; an unknown {x} stays.
export const fmt = (lang: Lang, key: string, vars: Record<string, string> = {}) =>
  (STRINGS[key]?.[lang] || STRINGS[key]?.en || key).replace(/\{(\w+)\}/g, (m, n: string) => vars[n] ?? m)

const ATTRS = ['placeholder', 'aria-label', 'title']

// Touches only `[data-i18n]` nodes, so switching never resets a half-filled form.
export const applyLang = (root: Document, lang: Lang) => {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const text = STRINGS[el.dataset.i18n!]?.[lang]
    const attr = el.dataset.i18nAttr
    if (!text) continue
    if (attr && ATTRS.includes(attr)) el.setAttribute(attr, text)
    else el.textContent = text
  }
  root.documentElement.lang = lang
  root.title = STRINGS.title?.[lang] ?? root.title
}
