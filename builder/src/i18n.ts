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
  'shrink.hint': { en: 'A kind 30405 is a replacement: publishing this list is what un-lists the rest, because nostr has no “remove one item” event. Un-listing is not deleting — those listings stay on the relays and your storefront still draws them, at the foot of the page and out of the sale’s order. And this is exactly what deliberately retiring an item looks like, which is why nobody can tell the two apart for you.', es: 'Al publicar esta lista, los demás artículos dejan de estar en la venta. Quitarlos no es borrarlos: siguen en tu tienda, al final de la página. Así se ve también quitar algo a propósito, y por eso solo tú sabes si fue tu intención.' },
  'shrink.ok': { en: 'Yes, un-list them. I meant to.', es: 'Sí, quítalos de la venta. Lo quiero así.' },
  'price.hint': { en: 'Sats only. There is no currency conversion anywhere in this app — that would need a price oracle, and an oracle is somebody else’s server. Price something in pesos by leaving the node field empty: it lists, it just has no Buy button.', es: 'Solo en sats. Esta app no convierte monedas. Para poner un precio en pesos, deja vacío el campo del nodo: el artículo se publica, pero sin botón de Comprar.' },
  'price.fiatNote': { en: 'This item was priced in another currency, so it keeps that price and stays cash at the table — no Buy button, no offer on your node, whatever the node field says. You can change the amount. You cannot change the currency here, and nothing in this app converts one to the other.', es: 'Este artículo tiene precio en otra moneda, así que se paga en efectivo y no tiene botón de Comprar. Puedes cambiar la cantidad, pero aquí no puedes cambiar la moneda. Esta app no convierte monedas.' },
}

// The keys with no non-empty `es`. The inventory test (G1.1) fails on any of these.
export const missing = (keys: string[], table: Record<string, { en: string; es?: string }> = STRINGS) =>
  keys.filter(k => !table[k]?.es?.trim())

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
