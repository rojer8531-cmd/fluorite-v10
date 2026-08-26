// i18n del Bot de Compras — traducción en el borde de envío (sendMessage/editMessageText).
// El texto base que produce el handler se traduce por segmentos según el idioma del usuario.
import { supabaseAdmin as sb } from "@/integrations/supabase/client.server";

export type Lang = "es" | "en" | "pt" | "hi";
export const LANGS: Lang[] = ["en", "pt", "es", "hi"];

export const LANG_LABEL: Record<Lang, string> = {
  en: "English",
  pt: "Português",
  es: "Español",
  hi: "India",
};

const DEFAULT_LANG: Lang = "es";

const langByChat = new Map<number, { value: Lang; at: number }>();
const langByUser = new Map<number, { value: Lang; at: number }>();
const TTL = 600_000;

/** Guarda el idioma ya conocido (evita una consulta extra al enviar mensajes). */
export function primeLang(telegram_id: number, chat_id: number, lang: unknown) {
  const value = norm(lang);
  const at = Date.now();
  langByUser.set(telegram_id, { value, at });
  langByChat.set(chat_id, { value, at });
}

function norm(v: unknown): Lang {
  return LANGS.includes(v as Lang) ? (v as Lang) : DEFAULT_LANG;
}

export async function getLangByChat(chat_id: number): Promise<Lang> {
  const hit = langByChat.get(chat_id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const { data } = await sb
      .from("bot_users")
      .select("lang, telegram_id")
      .eq("chat_id", chat_id)
      .maybeSingle();
    const value = norm((data as { lang?: string } | null)?.lang);
    langByChat.set(chat_id, { value, at: Date.now() });
    if (data?.telegram_id) langByUser.set(Number(data.telegram_id), { value, at: Date.now() });
    return value;
  } catch {
    return DEFAULT_LANG;
  }
}

export async function getLang(telegram_id: number): Promise<Lang> {
  const hit = langByUser.get(telegram_id);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const { data } = await sb
      .from("bot_users")
      .select("lang")
      .eq("telegram_id", telegram_id)
      .maybeSingle();
    const value = norm((data as { lang?: string } | null)?.lang);
    langByUser.set(telegram_id, { value, at: Date.now() });
    return value;
  } catch {
    return DEFAULT_LANG;
  }
}

export async function setLang(telegram_id: number, chat_id: number, lang: Lang) {
  langByUser.set(telegram_id, { value: lang, at: Date.now() });
  langByChat.set(chat_id, { value: lang, at: Date.now() });
  await sb.from("bot_users").update({ lang }).eq("telegram_id", telegram_id);
}

// ==========================================================================
// Diccionario: texto base (tal cual lo emite el handler) → traducciones.
// ==========================================================================
type Entry = Partial<Record<Lang, string>>;

const DICT: Record<string, Entry> = {
  // --- Barra inferior / navegación ---
  "🛍 Buy keys": { es: "🛍 Comprar keys", pt: "🛍 Comprar keys", hi: "🛍 कीज़ खरीदें" },
  "🏛️ Top Up Balance": { es: "🏛️ Recargar saldo", pt: "🏛️ Recarregar saldo", hi: "🏛️ बैलेंस टॉप अप" },
  "📜 My Profile": { es: "📜 Mi perfil", pt: "📜 Meu perfil", hi: "📜 मेरी प्रोफ़ाइल" },
  "➕ Support": { es: "➕ Soporte", pt: "➕ Suporte", hi: "➕ सहायता" },
  "🌐 Language": { es: "🌐 Idioma", pt: "🌐 Idioma", hi: "🌐 भाषा" },
  "🏘️ Home": { es: "🏘️ Inicio", pt: "🏘️ Início", hi: "🏘️ होम" },
  "🔙 Go Back": { es: "🔙 Volver", pt: "🔙 Voltar", hi: "🔙 वापस" },
  "↩️ Volver": { en: "↩️ Back", pt: "↩️ Voltar", hi: "↩️ वापस" },
  "Volver": { en: "Back", pt: "Voltar", hi: "वापस" },
  "✖️ Cancelar": { en: "✖️ Cancel", pt: "✖️ Cancelar", hi: "✖️ रद्द करें" },
  "✅ Aceptar": { en: "✅ Accept", pt: "✅ Aceitar", hi: "✅ स्वीकार करें" },
  "✅ Ya Pagué": { en: "✅ I already paid", pt: "✅ Já paguei", hi: "✅ मैंने भुगतान कर दिया" },
  "📥 Download Reseller Panel": { es: "📥 Descargar panel de reseller", pt: "📥 Baixar painel de revenda", hi: "📥 रीसेलर पैनल डाउनलोड करें" },
  "Download Reseller Panel": { es: "Descargar panel de reseller", pt: "Baixar painel de revenda", hi: "रीसेलर पैनल डाउनलोड करें" },
  "📥 Abrir Panel": { en: "📥 Open Panel", pt: "📥 Abrir painel", hi: "📥 पैनल खोलें" },
  "📥 Descargar Panel": { en: "📥 Download Panel", pt: "📥 Baixar painel", hi: "📥 पैनल डाउनलोड करें" },
  "📢 Unirme al Canal": { en: "📢 Join the channel", pt: "📢 Entrar no canal", hi: "📢 चैनल से जुड़ें" },
  "📢 Canal Oficial": { en: "📢 Official Channel", pt: "📢 Canal oficial", hi: "📢 आधिकारिक चैनल" },

  // --- Menú principal / pantallas ---
  "Main Menu": { es: "Menú principal", pt: "Menu principal", hi: "मुख्य मेनू" },
  "Select an Option": { es: "Elegí una opción", pt: "Escolha uma opção", hi: "एक विकल्प चुनें" },
  "Select an option.": { es: "Elegí una opción.", pt: "Escolha uma opção.", hi: "एक विकल्प चुनें।" },
  "Choose a category:": { es: "Elegí una categoría:", pt: "Escolha uma categoria:", hi: "श्रेणी चुनें:" },
  "Choose a product in category": { es: "Elegí un producto en la categoría", pt: "Escolha um produto na categoria", hi: "इस श्रेणी में उत्पाद चुनें" },
  "Choose the bot language:": { es: "Elegí el idioma del bot:", pt: "Escolha o idioma do bot:", hi: "बॉट की भाषा चुनें:" },
  "Selecciona una duración": { en: "Choose a duration", pt: "Escolha uma duração", hi: "अवधि चुनें" },
  "All My Profile Information and Data": { es: "Toda la información de mi perfil", pt: "Todas as informações do meu perfil", hi: "मेरी प्रोफ़ाइल की पूरी जानकारी" },
  "Select your country and top up your balance": { es: "Elegí tu país y recargá tu saldo", pt: "Escolha seu país e recarregue seu saldo", hi: "अपना देश चुनें और बैलेंस टॉप अप करें" },

  // --- Perfil / saldo ---
  "Nombre:": { en: "Name:", pt: "Nome:", hi: "नाम:" },
  "Usuario:": { en: "Username:", pt: "Usuário:", hi: "उपयोगकर्ता:" },
  "Saldo Actual:": { en: "Current Balance:", pt: "Saldo atual:", hi: "वर्तमान बैलेंस:" },
  "Total Comprado:": { en: "Total Purchased:", pt: "Total comprado:", hi: "कुल खरीद:" },
  "Saldo actual:": { en: "Current balance:", pt: "Saldo atual:", hi: "वर्तमान बैलेंस:" },
  "Saldo:": { en: "Balance:", pt: "Saldo:", hi: "बैलेंस:" },
  "Saldo insuficiente": { en: "Insufficient balance", pt: "Saldo insuficiente", hi: "अपर्याप्त बैलेंस" },
  "Necesitás más saldo para comprar esta key. Usá": { en: "You need more balance to buy this key. Use", pt: "Você precisa de mais saldo para comprar esta key. Use", hi: "इस की को खरीदने के लिए और बैलेंस चाहिए। उपयोग करें" },
  "para agregar saldo.": { en: "to add balance.", pt: "para adicionar saldo.", hi: "बैलेंस जोड़ने के लिए।" },
  "Recargar": { en: "Top Up", pt: "Recarregar", hi: "टॉप अप" },

  // --- Compra ---
  "Producto no disponible. Elegí otro producto.": { en: "Product unavailable. Choose another product.", pt: "Produto indisponível. Escolha outro produto.", hi: "उत्पाद उपलब्ध नहीं है। दूसरा उत्पाद चुनें।" },
  "Producto no disponible.": { en: "Product unavailable.", pt: "Produto indisponível.", hi: "उत्पाद उपलब्ध नहीं है।" },
  "Sin duraciones disponibles.": { en: "No durations available.", pt: "Nenhuma duração disponível.", hi: "कोई अवधि उपलब्ध नहीं है।" },
  "No hay productos disponibles en": { en: "No products available in", pt: "Não há produtos disponíveis em", hi: "इसमें कोई उत्पाद उपलब्ध नहीं:" },
  "No hay productos disponibles.": { en: "No products available.", pt: "Não há produtos disponíveis.", hi: "कोई उत्पाद उपलब्ध नहीं है।" },
  "No hay métodos de pago disponibles.": { en: "No payment methods available.", pt: "Nenhum método de pagamento disponível.", hi: "कोई भुगतान विधि उपलब्ध नहीं है।" },
  "No hay métodos disponibles para este país.": { en: "No methods available for this country.", pt: "Nenhum método disponível para este país.", hi: "इस देश के लिए कोई विधि उपलब्ध नहीं है।" },
  "Sin Stock": { en: "Out of stock", pt: "Sem estoque", hi: "स्टॉक ख़त्म" },
  "Stock no disponible, pedir key manual?": { en: "Out of stock — request a manual key?", pt: "Sem estoque — pedir key manual?", hi: "स्टॉक नहीं है — मैनुअल की मंगाएँ?" },
  "Stock no disponible": { en: "Out of stock", pt: "Sem estoque", hi: "स्टॉक उपलब्ध नहीं" },
  "¿Querés pedir la key en modo manual? Un administrador te la enviará apenas esté lista.": { en: "Do you want to request the key manually? An admin will send it as soon as it's ready.", pt: "Quer pedir a key no modo manual? Um administrador enviará assim que estiver pronta.", hi: "क्या आप की मैनुअल रूप से मंगाना चाहते हैं? एडमिन तैयार होते ही भेज देगा।" },
  "Sin stock automático. La key será entregada manualmente por el admin.": { en: "No automatic stock. The key will be delivered manually by the admin.", pt: "Sem estoque automático. A key será entregue manualmente pelo admin.", hi: "स्वचालित स्टॉक नहीं। की एडमिन द्वारा मैनुअल भेजी जाएगी।" },
  "No se pudo completar la compra. Tocá de nuevo en unos segundos.": { en: "Purchase could not be completed. Try again in a few seconds.", pt: "Não foi possível concluir a compra. Tente novamente em alguns segundos.", hi: "खरीद पूरी नहीं हो सकी। कुछ सेकंड बाद फिर कोशिश करें।" },
  "Esa compra expiró. Elegí el producto nuevamente.": { en: "That purchase expired. Choose the product again.", pt: "Essa compra expirou. Escolha o produto novamente.", hi: "वह खरीद समाप्त हो गई। उत्पाद फिर चुनें।" },
  "Esa opción ya no está disponible. Volví al menú principal.": { en: "That option is no longer available. Back to the main menu.", pt: "Essa opção não está mais disponível. Voltei ao menu principal.", hi: "वह विकल्प अब उपलब्ध नहीं है। मुख्य मेनू पर वापस।" },
  "Compra Realizada": { en: "Purchase Completed", pt: "Compra realizada", hi: "खरीद पूरी हुई" },
  "Purchase Confirmed": { es: "Compra confirmada", pt: "Compra confirmada", hi: "खरीद की पुष्टि" },
  "¡Gracias por tu compra!": { en: "Thanks for your purchase!", pt: "Obrigado pela sua compra!", hi: "आपकी खरीद के लिए धन्यवाद!" },
  "Gracias por tu compra.": { en: "Thanks for your purchase.", pt: "Obrigado pela sua compra.", hi: "आपकी खरीद के लिए धन्यवाद।" },
  "Gracias por tu paciencia.": { en: "Thanks for your patience.", pt: "Obrigado pela paciência.", hi: "आपके धैर्य के लिए धन्यवाद।" },
  "Tu key será enviada por un administrador en unos minutos.": { en: "Your key will be sent by an admin in a few minutes.", pt: "Sua key será enviada por um administrador em alguns minutos.", hi: "आपकी की कुछ मिनटों में एडमिन भेजेगा।" },
  "Cantidad": { en: "Quantity", pt: "Quantidade", hi: "मात्रा" },
  "Duración:": { en: "Duration:", pt: "Duração:", hi: "अवधि:" },
  "Duración": { en: "Duration", pt: "Duração", hi: "अवधि" },
  "Producto": { en: "Product", pt: "Produto", hi: "उत्पाद" },
  "Total": { en: "Total", pt: "Total", hi: "कुल" },
  "Pagas": { en: "You pay", pt: "Você paga", hi: "आप भुगतान करें" },
  "Titular": { en: "Holder", pt: "Titular", hi: "खाताधारक" },
  "Cuenta": { en: "Account", pt: "Conta", hi: "खाता" },
  "Local": { en: "Local", pt: "Local", hi: "स्थानीय" },
  "(referencial)": { en: "(reference)", pt: "(referencial)", hi: "(संदर्भ)" },
  "Orden:": { en: "Order:", pt: "Pedido:", hi: "ऑर्डर:" },
  "Confirmar": { en: "Confirm", pt: "Confirmar", hi: "पुष्टि करें" },
  "compra": { en: "purchase", pt: "compra", hi: "खरीद" },

  // --- Recarga / comprobantes ---
  "Recarga Aprobada": { en: "Top Up Approved", pt: "Recarga aprovada", hi: "टॉप अप स्वीकृत" },
  "Recarga Rechazada": { en: "Top Up Declined", pt: "Recarga recusada", hi: "टॉप अप अस्वीकृत" },
  "Recarga Mínima:": { en: "Minimum Top Up:", pt: "Recarga mínima:", hi: "न्यूनतम टॉप अप:" },
  "Recarga:": { en: "Top up:", pt: "Recarga:", hi: "टॉप अप:" },
  "Recarga": { en: "Top Up", pt: "Recarga", hi: "टॉप अप" },
  "Saldo Agregado:": { en: "Balance Added:", pt: "Saldo adicionado:", hi: "बैलेंस जोड़ा गया:" },
  "Ya puedes utilizar tu saldo para realizar compras dentro del bot.": { en: "You can now use your balance to buy inside the bot.", pt: "Agora você pode usar seu saldo para comprar no bot.", hi: "अब आप बॉट में खरीदारी के लिए अपना बैलेंस उपयोग कर सकते हैं।" },
  "¿Cuánto deseas recargar?": { en: "How much do you want to top up?", pt: "Quanto deseja recarregar?", hi: "आप कितना टॉप अप करना चाहते हैं?" },
  "Ejemplo:": { en: "Example:", pt: "Exemplo:", hi: "उदाहरण:" },
  "Escribí el monto en USD.": { en: "Type the amount in USD.", pt: "Digite o valor em USD.", hi: "USD में राशि लिखें।" },
  "Monto inválido. Escribí solo números, ej:": { en: "Invalid amount. Type numbers only, e.g.:", pt: "Valor inválido. Digite apenas números, ex.:", hi: "अमान्य राशि। केवल संख्याएँ लिखें, जैसे:" },
  "El monto mínimo es": { en: "The minimum amount is", pt: "O valor mínimo é", hi: "न्यूनतम राशि है" },
  "Probá de nuevo.": { en: "Try again.", pt: "Tente novamente.", hi: "फिर कोशिश करें।" },
  "Enviá la foto del comprobante a este chat.": { en: "Send the receipt photo to this chat.", pt: "Envie a foto do comprovante neste chat.", hi: "रसीद की फोटो इस चैट में भेजें।" },
  "Solo fotos. Imágenes duplicadas serán rechazadas.": { en: "Photos only. Duplicate images will be rejected.", pt: "Apenas fotos. Imagens duplicadas serão rejeitadas.", hi: "केवल फोटो। डुप्लिकेट इमेज अस्वीकार होंगी।" },
  "Comprobante En Revisión": { en: "Receipt Under Review", pt: "Comprovante em análise", hi: "रसीद समीक्षा में" },
  "Comprobante en revisión": { en: "Receipt under review", pt: "Comprovante em análise", hi: "रसीद समीक्षा में" },
  "Tu comprobante está siendo verificado.": { en: "Your receipt is being verified.", pt: "Seu comprovante está sendo verificado.", hi: "आपकी रसीद सत्यापित की जा रही है।" },
  "No lo envíes nuevamente. Los comprobantes duplicados pueden ser rechazados.": { en: "Do not send it again. Duplicate receipts may be rejected.", pt: "Não envie novamente. Comprovantes duplicados podem ser rejeitados.", hi: "इसे दोबारा न भेजें। डुप्लिकेट रसीदें अस्वीकार हो सकती हैं।" },
  "Tiempo estimado:": { en: "Estimated time:", pt: "Tempo estimado:", hi: "अनुमानित समय:" },
  "En alta demanda:": { en: "High demand:", pt: "Alta demanda:", hi: "अधिक मांग में:" },
  "Tu comprobante fue rechazado. Puedes enviar uno nuevo.": { en: "Your receipt was declined. You can send a new one.", pt: "Seu comprovante foi recusado. Você pode enviar outro.", hi: "आपकी रसीद अस्वीकृत हुई। आप नई भेज सकते हैं।" },
  "Comprobante inválido.": { en: "Invalid receipt.", pt: "Comprovante inválido.", hi: "अमान्य रसीद।" },
  "Este comprobante pertenece a otro usuario y no puede ser usado.": { en: "This receipt belongs to another user and cannot be used.", pt: "Este comprovante pertence a outro usuário e não pode ser usado.", hi: "यह रसीद किसी अन्य उपयोगकर्ता की है और उपयोग नहीं की जा सकती।" },
  "Imagen demasiado pequeña. Enviá el comprobante completo.": { en: "Image too small. Send the full receipt.", pt: "Imagem muito pequena. Envie o comprovante completo.", hi: "इमेज बहुत छोटी है। पूरी रसीद भेजें।" },
  "Error descargando documento. Intentá enviar el comprobante nuevamente.": { en: "Error downloading document. Try sending the receipt again.", pt: "Erro ao baixar o documento. Tente enviar o comprovante novamente.", hi: "दस्तावेज़ डाउनलोड में त्रुटि। रसीद फिर भेजें।" },
  "Error descargando imagen. Intentá enviar el comprobante nuevamente.": { en: "Error downloading image. Try sending the receipt again.", pt: "Erro ao baixar a imagem. Tente enviar o comprovante novamente.", hi: "इमेज डाउनलोड में त्रुटि। रसीद फिर भेजें।" },
  "Error procesando documento. Intentá enviar el comprobante nuevamente.": { en: "Error processing document. Try sending the receipt again.", pt: "Erro ao processar o documento. Tente enviar o comprovante novamente.", hi: "दस्तावेज़ प्रोसेस करने में त्रुटि। रसीद फिर भेजें।" },
  "Error procesando imagen. Intentá enviar el comprobante nuevamente.": { en: "Error processing image. Try sending the receipt again.", pt: "Erro ao processar a imagem. Tente enviar o comprovante novamente.", hi: "इमेज प्रोसेस करने में त्रुटि। रसीद फिर भेजें।" },
  "No tenés una orden pendiente. Iniciá una compra o recarga primero.": { en: "You have no pending order. Start a purchase or top up first.", pt: "Você não tem pedido pendente. Inicie uma compra ou recarga primeiro.", hi: "कोई लंबित ऑर्डर नहीं है। पहले खरीद या टॉप अप शुरू करें।" },
  "No tenés una recarga pendiente.": { en: "You have no pending top up.", pt: "Você não tem recarga pendente.", hi: "कोई लंबित टॉप अप नहीं है।" },
  "Para enviar comprobante iniciá una recarga primero.": { en: "To send a receipt, start a top up first.", pt: "Para enviar comprovante, inicie uma recarga primeiro.", hi: "रसीद भेजने के लिए पहले टॉप अप शुरू करें।" },
  "Por favor espera la revisión del comprobante actual.": { en: "Please wait for the current receipt review.", pt: "Aguarde a análise do comprovante atual.", hi: "कृपया वर्तमान रसीद की समीक्षा की प्रतीक्षा करें।" },
  "Si continúas enviando el mismo comprobante tu cuenta podrá ser bloqueada y podrías perder tu pago.": { en: "If you keep sending the same receipt your account may be blocked and you could lose your payment.", pt: "Se continuar enviando o mesmo comprovante sua conta poderá ser bloqueada e você pode perder o pagamento.", hi: "यदि आप वही रसीद भेजते रहे तो खाता ब्लॉक हो सकता है और भुगतान खो सकते हैं।" },
  "Si Subes El Comprobante Varias Veces Tu Recarga Será Rechazada Sin Lugar A Reclamo.": { en: "If you upload the receipt several times your top up will be declined with no claim.", pt: "Se enviar o comprovante várias vezes sua recarga será recusada sem direito a reclamação.", hi: "यदि आप रसीद कई बार भेजते हैं तो टॉप अप बिना दावे के अस्वीकार होगा।" },
  "Apenas Lo Envíes, Lo Revisaremos.": { en: "As soon as you send it, we'll review it.", pt: "Assim que enviar, vamos revisar.", hi: "जैसे ही आप भेजेंगे, हम समीक्षा करेंगे।" },
  "Se Paciente Y Espera.": { en: "Be patient and wait.", pt: "Tenha paciência e aguarde.", hi: "धैर्य रखें और प्रतीक्षा करें।" },
  "Ya tenés": { en: "You already have", pt: "Você já tem", hi: "आपके पास पहले से हैं" },
  "3 órdenes activas": { en: "3 active orders", pt: "3 pedidos ativos", hi: "3 सक्रिय ऑर्डर" },
  "Esperá que alguna sea aprobada para crear otra.": { en: "Wait until one is approved to create another.", pt: "Aguarde a aprovação de uma para criar outra.", hi: "दूसरा बनाने के लिए किसी एक की स्वीकृति की प्रतीक्षा करें।" },
  "Admin no configurado. Avisá a soporte.": { en: "Admin not configured. Contact support.", pt: "Admin não configurado. Avise o suporte.", hi: "एडमिन कॉन्फ़िगर नहीं है। सहायता से संपर्क करें।" },

  // --- Órdenes / keys ---
  "No tenés órdenes.": { en: "You have no orders.", pt: "Você não tem pedidos.", hi: "आपके कोई ऑर्डर नहीं हैं।" },
  "Aún no tenés keys.": { en: "You don't have keys yet.", pt: "Você ainda não tem keys.", hi: "आपके पास अभी कोई की नहीं है।" },
  "Aprobado": { en: "Approved", pt: "Aprovado", hi: "स्वीकृत" },
  "En revisión": { en: "Under review", pt: "Em análise", hi: "समीक्षा में" },
  "Esperando comprobante": { en: "Waiting for receipt", pt: "Aguardando comprovante", hi: "रसीद की प्रतीक्षा" },
  "Pendiente": { en: "Pending", pt: "Pendente", hi: "लंबित" },
  "Rechazado": { en: "Declined", pt: "Recusado", hi: "अस्वीकृत" },
  "Enviado:": { en: "Sent:", pt: "Enviado:", hi: "भेजा गया:" },
  "Hoy": { en: "Today", pt: "Hoje", hi: "आज" },
  "Ayer": { en: "Yesterday", pt: "Ontem", hi: "कल" },
  "Hace": { en: "", pt: "Há", hi: "" },
  "días": { en: "days ago", pt: "dias", hi: "दिन पहले" },

  // --- Soporte / varios ---
  "Soporte": { en: "Support", pt: "Suporte", hi: "सहायता" },
  "Escribinos por Telegram a": { en: "Message us on Telegram at", pt: "Fale conosco no Telegram em", hi: "टेलीग्राम पर हमें लिखें" },
  "Te respondemos a la brevedad.": { en: "We reply as soon as possible.", pt: "Respondemos o mais breve possível.", hi: "हम जल्द ही उत्तर देंगे।" },
  "Nombre inválido. Ingresá entre 2 y 40 caracteres.": { en: "Invalid name. Enter between 2 and 40 characters.", pt: "Nome inválido. Digite entre 2 e 40 caracteres.", hi: "अमान्य नाम। 2 से 40 अक्षर दर्ज करें।" },
  "No disponible": { en: "Unavailable", pt: "Indisponível", hi: "अनुपलब्ध" },
  "No se pudo generar el link. Intentá más tarde.": { en: "The link could not be generated. Try again later.", pt: "Não foi possível gerar o link. Tente mais tarde.", hi: "लिंक नहीं बन सका। बाद में कोशिश करें।" },
  "Compartir Bot": { en: "Share Bot", pt: "Compartilhar bot", hi: "बॉट साझा करें" },
  "Copiar link": { en: "Copy link", pt: "Copiar link", hi: "लिंक कॉपी करें" },
  "Compartir ahora": { en: "Share now", pt: "Compartilhar agora", hi: "अभी साझा करें" },
  "Mostrar link": { en: "Show link", pt: "Mostrar link", hi: "लिंक दिखाएँ" },
  "Estoy en línea.": { en: "I'm online.", pt: "Estou online.", hi: "मैं ऑनलाइन हूँ।" },
  "Toca /start nuevamente en unos segundos si el menú no termina de cargar.": { en: "Tap /start again in a few seconds if the menu doesn't finish loading.", pt: "Toque /start novamente em alguns segundos se o menu não carregar.", hi: "अगर मेनू लोड न हो तो कुछ सेकंड बाद फिर /start दबाएँ।" },
  "El bot está activo. No se pudo completar esa acción en este intento; vuelve a tocar la opción.": { en: "The bot is active. That action could not be completed this time; tap the option again.", pt: "O bot está ativo. Não foi possível concluir essa ação; toque na opção novamente.", hi: "बॉट सक्रिय है। यह क्रिया पूरी नहीं हो सकी; विकल्प फिर दबाएँ।" },
};

// Frases dinámicas de confirmación de idioma
export function langAppliedText(lang: Lang) {
  const label = LANG_LABEL[lang];
  const suffix: Record<Lang, string> = {
    en: "applied correctly",
    es: "aplicado correctamente",
    pt: "aplicado corretamente",
    hi: "सफलतापूर्वक लागू किया गया",
  };
  return `✅ <b>${label} ${suffix[lang]}</b>`;
}

export function langMenuTitle(lang: Lang) {
  const t: Record<Lang, string> = {
    en: "🔎 <b>Choose the bot language:</b>",
    es: "🔎 <b>Elegí el idioma del bot:</b>",
    pt: "🔎 <b>Escolha o idioma do bot:</b>",
    hi: "🔎 <b>बॉट की भाषा चुनें:</b>",
  };
  return t[lang];
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const KEYS = Object.keys(DICT).sort((a, b) => b.length - a.length);
const PATTERN = new RegExp(KEYS.map(escapeRe).join("|"), "g");

/** Traduce el texto base por segmentos. Lo desconocido se deja tal cual. */
export function translate(text: string, lang: Lang): string {
  if (!text) return text;
  return text.replace(PATTERN, (m) => {
    const entry = DICT[m];
    const out = entry?.[lang];
    return out === undefined ? m : out;
  });
}

type Btn = { text?: string; [k: string]: unknown };

export function translateMarkup(markup: unknown, lang: Lang): unknown {
  if (!markup || typeof markup !== "object") return markup;
  const m = markup as Record<string, unknown>;
  const out: Record<string, unknown> = { ...m };
  const mapRows = (rows: unknown) =>
    Array.isArray(rows)
      ? rows.map((row) =>
          Array.isArray(row)
            ? row.map((b: Btn) => (b && typeof b.text === "string" ? { ...b, text: translate(b.text, lang) } : b))
            : row,
        )
      : rows;
  if (m.inline_keyboard) out.inline_keyboard = mapRows(m.inline_keyboard);
  if (m.keyboard) out.keyboard = mapRows(m.keyboard);
  return out;
}

// Mapa inverso: cualquier traducción de un texto base vuelve a su base.
const REVERSE = new Map<string, string>();
for (const [base, entry] of Object.entries(DICT)) {
  for (const v of Object.values(entry)) {
    if (v && !REVERSE.has(v)) REVERSE.set(v, base);
  }
}

/** Devuelve el texto base a partir de una etiqueta traducida (o el mismo texto). */
export function untranslate(text: string): string {
  return REVERSE.get(text.trim()) ?? text;
}
