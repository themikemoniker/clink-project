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
  // #125: panel 5's warning about sale amounts. Plain text: applyLang writes textContent. The es names
  // no protocol, call, command or file (needs-native-review).
  'sales.note': { en: 'What is not here is what each sale was worth. CLINK Manage’s only resource is the offer — there is no invoice or settlement resource anywhere in CLINK — and the node’s own call for it, GetUserOfferInvoices, rides a request kind a signer holding your key on your phone cannot construct. So a browser that never touches your key cannot read your sales, and that is the cost of the custody claim rather than a missing feature. Run node spike/sales-report.ts on the machine with your node for amounts, timestamps, and how many of each item’s sales carry a refund pointer — it prints the count, never the pointers themselves, because a refund pointer identifies a buyer.', es: 'Aquí no ves cuánto dejó cada venta: tu teléfono guarda tu clave y esta página nunca la toca. Los montos salen en el reporte de ventas, en la computadora que cobra tus pagos.' },
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
  // #106: the edit-an-item flow. `edit.*` hold {title} or {d}, so they never sit on a data-i18n node.
  'item.publish': { en: 'Publish this item', es: 'Publicar este artículo' },
  'item.edit': { en: 'Edit', es: 'Cambiar' },
  'item.markSold': { en: 'Mark sold', es: 'Ya se vendió' },
  // #63: the meta line under each item. A stock count picks `.one` or `.other` through `countKey`.
  'meta.left.one': { en: '{n} left', es: 'queda {n}' },
  'meta.left.other': { en: '{n} left', es: 'quedan {n}' },
  'meta.sold': { en: 'sold', es: 'vendido' },
  'meta.gone': { en: '{s}/{u} gone', es: '{s}/{u} vendidos' },
  'meta.buy': { en: 'Buy button', es: 'botón de Comprar' },
  'meta.cash': { en: 'cash only', es: 'solo efectivo' },
  'meta.noPrice': { en: 'no price', es: 'sin precio' },
  'edit.publishChanges': { en: 'Publish changes to “{title}”', es: 'Publicar cambios en “{title}”' },
  'edit.markSold': { en: 'Mark “{title}” sold', es: 'Marcar “{title}” como vendido' },
  'edit.note': { en: 'Editing {d}. It replaces the listing at the same address — nostr has no edit, only replacement — and re-cuts the availability ladder, so your watcher needs the new file afterwards.', es: 'Estás cambiando “{d}”. Al publicar, reemplaza al anuncio de antes. Luego revisa la sección 6.' },
  'edit.soldNote': { en: 'Its Buy button disappears as soon as this publishes, because a sold listing carries no offer pointer. The offer itself stays on your node — deleting it would take the buyer’s stored refund pointer with it, and a payment that lands late still has to be refundable.', es: 'Al publicar, se quita su botón de Comprar. Tu nodo guarda el cobro por si hay que devolver un pago que llegue tarde.' },
  'edit.check': { en: 'Check it over, then publish.', es: 'Revísalo y luego publícalo.' },
  'edit.loaded': { en: 'Loaded. Change what you need, then publish.', es: 'Listo. Cambia lo que necesites y luego publícalo.' },
  // #126: the item checks, the notes lines, Disconnect and Cancel. `err.generic` never shows {msg} in es.
  'item.noSlug': { en: 'Give the item a title, or a slug.', es: 'Ponle un nombre al artículo.' },
  'item.noTitle': { en: 'Give the item a title.', es: 'Falta el nombre del artículo.' },
  'item.badPrice': { en: 'Price must be a whole number of sats.', es: 'El precio debe ser un número entero de sats, sin decimales.' },
  'item.floor': { en: 'A buyable item must be at least 10 sats — the node will not invoice less. Set stock to 0, or clear the node field, to list it as cash-only.', es: 'Para venderlo con botón de Comprar, el precio mínimo es 10 sats. Si es menos, pon 0 en cantidad o deja vacío el campo del nodo: se vende solo en efectivo.' },
  'item.badStock': { en: 'Stock must be 0–999.', es: 'La cantidad debe ser de 0 a 999.' },
  'err.generic': { en: '{msg}', es: 'Algo salió mal. Inténtalo otra vez en un momento.' },
  'notes.encrypting': { en: 'Encrypting to your own key…', es: 'Guardando tus notas en secreto…' },
  'notes.saved': { en: 'Notes saved on {ok}/{all} relays. Only your key can read them.', es: 'Notas guardadas en {ok}/{all} servidores. Solo tú puedes leerlas.' },
  'notes.none': { en: 'No relay took your notes. Nothing was lost — press it again.', es: 'Ningún servidor guardó tus notas. No se perdió nada. Presiona otra vez.' },
  'status.disconnected': { en: 'Disconnected.', es: 'Desconectado.' },
  'edit.cancelled': { en: 'Back to a new item. Nothing was changed.', es: 'De vuelta a un artículo nuevo. No se cambió nada.' },
  // #103: the Deploy progress lines. deploy.ts names the key; `en` is the exact English it wrote.
  'deploy.reading': { en: 'Reading the storefront…', es: 'Preparando los archivos de tu tienda…' },
  'deploy.hash': { en: 'Hashing {n} files…', es: 'Revisando {n} archivos…' },
  'deploy.uploading': { en: 'Uploading…', es: 'Subiendo archivos…' },
  'deploy.upload': { en: 'Uploading {done}/{total}…', es: 'Subiendo archivos: {done} de {total}…' },
  'deploy.publish': { en: 'Publishing the manifest to {n} relays…', es: 'Publicando tu venta en {n} servidores…' },
  'deploy.live': { en: 'Live at {url}', es: 'Listo: tu venta está en {url}' },
  // #109: the failures publish.ts writes itself (PublishError). `en` is its exact English; es never shows {msg}.
  'publish.noRelay': { en: 'No relay accepted the listing. It is signed but nobody can see it — try again.', es: 'Tu artículo está listo, pero nadie lo puede ver todavía. Presiona Publicar otra vez en un momento.' },
  'publish.noRelaySale': { en: 'No relay accepted the sale. It is signed but nobody can see it — try again.', es: 'Tu venta está lista, pero nadie la puede ver todavía. Presiona Publicar otra vez en un momento.' },
  'publish.mintFail': { en: 'Could not mint the offer: {msg}', es: 'No se pudo preparar el botón de Comprar. Revisa la dirección de tu nodo en la sección 2, o deja vacío el campo del nodo para venderlo solo en efectivo.' },
  'publish.notSent': { en: '{msg}', es: 'No se publicó nada. Revisa los datos del artículo e inténtalo otra vez.' },
  'deploy.detail':{ en: '{n} files on {s} Blossom server(s), manifest on {ok}/{all} relays. Site version {v}…. The first request may time out while the gateway fetches the blobs — reload once.', es: '{n} archivos en {s} servidor(es) de archivos y {ok}/{all} servidores con el índice. Versión del sitio {v}…. La primera visita puede tardar. Si falla, vuelve a cargar una vez.' },
  // #141: step 2's static text (needs-native-review). The hint lost its <code>: applyLang writes plain
  // text. The es names no command, file, nmanage, CLINK or relay.
  's2.h': { en: '2 · Your node', es: '2 · Tu nodo' },
  's2.optional': { en: 'optional', es: 'opcional' },
  's2.label': { en: 'CLINK Manage pointer', es: 'Código de tu nodo' },
  's2.placeholder': { en: 'nmanage1…', es: 'Pega aquí el código de tu nodo' },
  's2.hint': { en: 'Run node spike/authorize-manage.ts once, on the machine with your node, and paste the line it writes. This pointer addresses your account, so it stays in this browser — it is never published and never sent anywhere but your own node.', es: 'Este código te lo da quien instaló tu nodo. Se queda en el navegador de este teléfono. Nunca se publica y solo se envía a tu propio nodo.' },
  // #123: the #node-state line setNode writes (needs-native-review). The es never names a terminal
  // command or a file, and never shows {relay}: the seller cannot act on either.
  'node.none': { en: 'No node — items will publish as cash-only, with no Buy button.', es: 'Sin nodo: tus artículos se publican solo para pago en efectivo, sin botón de Comprar.' },
  'node.bad': { en: 'That is not an nmanage1… pointer. Run `node spike/authorize-manage.ts` and paste what it writes.', es: 'Ese código no es válido. Pídelo otra vez a quien instaló tu nodo y pégalo completo.' },
  'node.ok': { en: 'Node {key}… on {relay}. Offers will be minted over CLINK Manage.', es: 'Nodo conectado ({key}…). Tus artículos tendrán botón de Comprar.' },
  // #130: why Publish sale is off (admin.ts noPublishSaleReason; needs-native-review). The quorum
  // es names the real es label of `items.reload`.
  'sale.no.signer': { en: 'Connect a signer first.', es: 'Primero conecta tu app de firma.' },
  'sale.no.loading': { en: 'Still reading your items from the relays — publishing now would send an empty sale.', es: 'Todavía estamos leyendo tus artículos. Si publicas ahora, tu venta saldría vacía.' },
  'sale.no.empty': { en: 'No items came back from the relays. Publishing now would replace your sale with an empty one.', es: 'No llegó ningún artículo de los servidores. Si publicas ahora, tu venta quedaría vacía.' },
  'sale.no.quorum': { en: 'Only {answered} of {relays} relays answered, so this list may be short. Press “Reload my items”.', es: 'Solo {answered} de {relays} servidores respondieron. Puede faltar algo. Presiona “Volver a cargar mis artículos”.' },
  'sale.cannot': { en: 'Cannot publish yet: {reason}', es: 'Aún no se puede publicar: {reason}' },
  // #158: photo and location failures (needs-native-review). `en` is the exact old English; es never shows {msg}.
  'photo.noServer': { en: 'No Blossom server accepted the photo. The listing can still publish without one.', es: 'No se pudo guardar la foto. Puedes publicar el artículo sin foto, o intentarlo más tarde.' },
  // #159: the photo status line (#photo-state). `en` is the exact old English; es never says px or Blossom.
  'photo.hint': { en: 'Resized in your browser to 1200, 480 and 160px. The original is never uploaded.', es: 'Tu foto se hace más chica en tu teléfono. La original nunca se sube.' },
  'photo.none': { en: 'No photo on this item yet.', es: 'Este artículo todavía no tiene foto.' },
  'photo.have': { en: '{sizes} already on Blossom. Leave the file field empty to keep them.', es: 'Este artículo ya tiene foto. Deja vacío el campo para conservarla.' },
  'photo.stored': { en: '{sizes} on Blossom.', es: 'Tu foto ya está guardada.' },
  'geo.none':{ en: 'This browser has no geolocation. Type the geohash instead.', es: 'Este navegador no puede saber dónde estás. Escribe el código de tu zona.' },
  'geo.fail': { en: 'Could not read your location: {msg}. Type the geohash instead.', es: 'Tu teléfono no pudo saber dónde estás. Permite la ubicación, o escribe el código de tu zona.' },
}

// The keys with no non-empty `es`. The inventory test (G1.1) fails on any of these.
export const missing = (keys: string[], table: Record<string, { en: string; es?: string }> = STRINGS) =>
  keys.filter(k => !table[k]?.es?.trim())

// A table text with each {name} replaced. An unknown key falls back to itself; an unknown {x} stays.
export const fmt = (lang: Lang, key: string, vars: Record<string, string> = {}) =>
  (STRINGS[key]?.[lang] || STRINGS[key]?.en || key).replace(/\{(\w+)\}/g, (m, n: string) => vars[n] ?? m)

// #63: `base.one` for exactly 1, else `base.other` (0 too). Two keys per count, no general rule.
export const countKey = (base: string, n: number) => `${base}.${n === 1 ? 'one' : 'other'}`

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
