/**
 * /shared/public-i18n.js
 * Shared EN/ES translation engine for the public + tenant-facing pages
 * (index.html, apply.html, tenant-portal.html). Kept as a plain global
 * script (not a module) so any of these pages can include it with a single
 * <script src="/shared/public-i18n.js"></script> tag, no build step.
 *
 * Usage in a page:
 *   <script src="/shared/public-i18n.js"></script>
 *   ... elements with data-i18n="some.key" ...
 *   <script type="module">
 *     await PublicI18N.init(); // detects/applies language, wires up toggle
 *   </script>
 *
 * Namespacing: common.* (shared everywhere), landing.* (index.html),
 * apply.* (apply.html), tenant.* (tenant-portal.html), cookie.* (banner).
 */
(function (global) {
  const DICT = {
    en: {
      // ── Common (shared across all pages) ──────────────────────────────
      'common.save': 'Save', 'common.cancel': 'Cancel', 'common.submit': 'Submit',
      'common.close': 'Close', 'common.loading': 'Loading…', 'common.required': 'Required',
      'common.optional': 'optional', 'common.edit': 'Edit', 'common.delete': 'Delete',
      'common.back': 'Back', 'common.next': 'Next', 'common.download': 'Download',
      'common.viewSite': 'View Site', 'common.signOut': 'Sign Out', 'common.email': 'Email',
      'common.phone': 'Phone', 'common.status.pending': 'Pending', 'common.status.approved': 'Approved',
      'common.status.paid': 'Paid', 'common.status.open': 'Open', 'common.status.closed': 'Closed',

      // ── index.html (landing) ──────────────────────────────────────────
      'landing.nav.properties': 'Properties', 'landing.nav.contact': 'Contact', 'landing.nav.admin': 'Admin',
      'landing.hero.eyebrow': 'Welcome',
      'landing.hero.title': 'Your Home,<br><em>Simplified.</em>',
      'landing.hero.subtitle': 'Pay rent, submit maintenance requests, access documents — all in one place.',
      'landing.hero.cta': 'Find Your Property ↓',
      'landing.properties.title': 'Our Properties', 'landing.properties.empty.title': 'No properties listed yet.',
      'landing.properties.empty.sub': 'Properties will appear here once added by the administrator.',
      'landing.properties.emptyRegion.title': 'No properties available in your region yet.',
      'landing.properties.emptyRegion.sub': 'Check back soon, or contact us for other locations.',
      'landing.badge.available': 'Available', 'landing.badge.unavailable': 'Not Available',
      'landing.units': 'Units', 'landing.applyNow': 'Apply Now', 'landing.tenantLogin': 'Tenant Login',
      'landing.footer.quickLinks': 'Quick Links', 'landing.footer.findProperty': 'Find Your Property',
      'landing.footer.payRent': 'Pay Rent Online', 'landing.footer.maintenance': 'Submit Maintenance',
      'landing.footer.contact': 'Contact', 'landing.footer.rights': 'All rights reserved.',
      'landing.login.title': 'Tenant Login', 'landing.login.email': 'Email Address',
      'landing.login.password': 'Password', 'landing.login.signIn': 'Sign In',
      'landing.login.registerLink': 'New tenant? Register', 'landing.login.forgot': 'Forgot password?',
      'landing.login.activateHint': '🔑 <strong>First time activating?</strong> Enter your email above and click <strong>Forgot password?</strong> to get a fresh activation link.',
      'landing.register.title': 'Create Account', 'landing.register.subtitle': 'Your account will be reviewed by the property manager.',
      'landing.register.firstName': 'First Name *', 'landing.register.lastName': 'Last Name *',
      'landing.register.email': 'Email *', 'landing.register.password': 'Password * (min 6 chars)',
      'landing.register.phone': 'Phone Number', 'landing.register.unit': 'Unit Number',
      'landing.register.moveIn': 'Move-in Date', 'landing.register.submit': 'Submit Registration',
      'landing.register.loginLink': 'Already have an account? Sign In',
      'landing.admin.title': 'Admin Access', 'landing.admin.email': 'Email', 'landing.admin.password': 'Password',
      'landing.admin.signIn': 'Admin Sign In', 'landing.admin.forgot': 'Forgot password?',

      // ── apply.html (rental application) ────────────────────────────────
      'apply.nav.back': '← Back to Portal',
      'apply.hero.eyebrow': 'Available Now', 'apply.hero.title': 'Find Your<br><em>Next Home</em>',
      'apply.hero.subtitle': 'Browse available properties and apply online. Our team reviews every application personally.',
      'apply.empty.title': 'No Units Available',
      'apply.empty.body': "We don't have any available units right now.<br>Check back soon or contact us to get on the waitlist.",
      'apply.card.available': 'Available', 'apply.card.availableUnits': 'Available Units',
      'apply.card.totalUnits': 'total units', 'apply.card.apply': 'Apply', 'apply.card.applyNow': 'Apply Now',
      'apply.card.unit': 'Unit',
      'apply.modal.title': 'Rental Application', 'apply.modal.loading': 'Loading…',
      'apply.success.title': 'Application Submitted',
      'apply.success.body': "Thank you! Your application has been received and is under review. We'll be in touch within 2–5 business days.",
      'apply.success.emailNote': 'A confirmation email with your data rights disclosure has been sent to your email address.',
      'apply.success.appId': 'Application ID:', 'apply.close': 'Close',
      'apply.step.you': 'You', 'apply.step.finances': 'Finances', 'apply.step.consent': 'Consent',
      'apply.field.firstName': 'First Name', 'apply.field.lastName': 'Last Name',
      'apply.field.email': 'Email Address', 'apply.field.emailHint': 'Confirmation and application updates will be sent here.',
      'apply.field.phone': 'Phone Number', 'apply.field.moveIn': 'Desired Move-in',
      'apply.field.message': 'Message to Property Manager',
      'apply.field.messagePlaceholder': 'Tell us a bit about yourself or ask a question…',
      'apply.finances.intro': "This information is used solely to assess your ability to meet rental obligations. It is stored securely and never sold.",
      'apply.field.income': 'Gross Monthly Income ($)', 'apply.field.incomeHint': 'Before taxes. Leave blank if you prefer not to share.',
      'apply.field.employer': 'Current Employer', 'apply.field.employerHint': 'Or "Self-employed", "Retired", etc.',
      'apply.field.pets': 'Pets',
      'apply.pets.none': 'No pets', 'apply.pets.dogSmall': 'Dog (small, under 25 lbs)',
      'apply.pets.dogLarge': 'Dog (large, 25+ lbs)', 'apply.pets.cat': 'Cat',
      'apply.pets.other': 'Other', 'apply.pets.multiple': 'Multiple pets',
      'apply.finances.note': '<strong>Note:</strong> Providing false financial information may result in immediate application denial and could constitute fraud. We verify income at the lease stage, not during initial review.',
      'apply.privacy.title': '🔒 How We Use Your Information',
      'apply.privacy.item1': 'To evaluate your rental application',
      'apply.privacy.item2': 'To contact you regarding your application status',
      'apply.privacy.item3': 'To verify income and references <em>only if your application proceeds</em>',
      'apply.privacy.footer': '<strong>We do not sell your personal information.</strong> Data is stored securely and retained for 90 days for declined applications. You may request deletion at any time before a lease is signed.',
      'apply.consent.dataTitle': 'I consent to collection and use of my personal data',
      'apply.consent.required': 'Required', 'apply.consent.optionalStage': 'Optional at this stage',
      'apply.consent.dataBody': 'I authorize this property management company to collect, store, and process the personal information I have provided in this form for the purpose of evaluating my rental application.',
      'apply.consent.dataLegal': 'Your data is collected under CCPA (California) and GDPR (if applicable) frameworks. You have rights to access, correct, and delete your data. Consent recorded with timestamp and IP address.',
      'apply.consent.bgTitle': 'I authorize a background and credit check',
      'apply.consent.bgBody': 'If my application progresses, I authorize the landlord to obtain a consumer report (background check and/or credit check) from a third-party consumer reporting agency.',
      'apply.consent.bgLegal': 'You retain rights under the Fair Credit Reporting Act (FCRA). If a report is used to make an adverse decision, you will receive an Adverse Action Notice as required by law.',
      'apply.consent.termsTitle': 'I certify that all information is accurate',
      'apply.consent.termsBody': 'I certify under penalty of perjury that all information provided in this application is true and complete. I understand that providing false information may result in immediate denial or termination of tenancy.',
      'apply.consent.footerNote': "By submitting this application, your express consent is legally recorded along with the date, time, and IP address of submission as required for compliance with applicable privacy regulations.",
      'apply.nav.backBtn': '← Back', 'apply.nav.continue': 'Continue →', 'apply.nav.submit': 'Submit Application',
      'apply.footer.dataQuestion': 'Questions about your data? Contact us at',
      'apply.footer.emailFallback': 'the email on record', 'apply.footer.noSell': 'We do not sell personal information.',

      // ── tenant-portal.html ──────────────────────────────────────────────
      'tenant.nav.dashboard': 'Dashboard', 'tenant.nav.payments': 'Payments',
      'tenant.nav.invoices': 'Invoices', 'tenant.nav.documents': 'Documents',
      'tenant.nav.maintenance': 'Maintenance', 'tenant.nav.support': 'Support',
      'tenant.dashboard.recentPayments': 'Recent Payments', 'tenant.dashboard.leaseInfo': 'Lease Information',
      'tenant.payments.payRent': 'Pay Rent', 'tenant.payments.autoPay': '🔁 Automated Payments',
      'tenant.payments.history': 'Payment History',
      'tenant.invoices.title': 'My Invoices &amp; Receipts',
      'tenant.documents.mine': 'My Documents', 'tenant.documents.property': 'Property Documents',
      'tenant.maintenance.submit': 'Submit Repair Request', 'tenant.maintenance.mine': 'My Requests',
      'tenant.support.send': 'Send a Message', 'tenant.support.history': 'Message History',
      'tenant.support.features': '💡 Feature Requests',

      // ── Cookie consent banner ───────────────────────────────────────────
      'cookie.message': 'We use cookies to run this site and process payments securely. Some are required for the site to function; others help us understand how it\'s used. You can accept or decline non-essential cookies.',
      'cookie.accept': 'Accept All', 'cookie.reject': 'Reject Non-Essential',
      'cookie.manage': 'Manage Preferences', 'cookie.necessaryOnly': 'Necessary cookies keep the site and payments working and can\'t be turned off.',
      'cookie.save': 'Save Preferences',
    },
    es: {
      'common.save': 'Guardar', 'common.cancel': 'Cancelar', 'common.submit': 'Enviar',
      'common.close': 'Cerrar', 'common.loading': 'Cargando…', 'common.required': 'Obligatorio',
      'common.optional': 'opcional', 'common.edit': 'Editar', 'common.delete': 'Eliminar',
      'common.back': 'Atrás', 'common.next': 'Siguiente', 'common.download': 'Descargar',
      'common.viewSite': 'Ver Sitio', 'common.signOut': 'Cerrar Sesión', 'common.email': 'Correo',
      'common.phone': 'Teléfono', 'common.status.pending': 'Pendiente', 'common.status.approved': 'Aprobado',
      'common.status.paid': 'Pagado', 'common.status.open': 'Abierto', 'common.status.closed': 'Cerrado',

      'landing.nav.properties': 'Propiedades', 'landing.nav.contact': 'Contacto', 'landing.nav.admin': 'Administrador',
      'landing.hero.eyebrow': 'Bienvenido',
      'landing.hero.title': 'Tu Hogar,<br><em>Simplificado.</em>',
      'landing.hero.subtitle': 'Paga la renta, envía solicitudes de mantenimiento, accede a documentos — todo en un solo lugar.',
      'landing.hero.cta': 'Encuentra Tu Propiedad ↓',
      'landing.properties.title': 'Nuestras Propiedades', 'landing.properties.empty.title': 'Aún no hay propiedades listadas.',
      'landing.properties.empty.sub': 'Las propiedades aparecerán aquí una vez que el administrador las agregue.',
      'landing.properties.emptyRegion.title': 'Aún no hay propiedades disponibles en tu región.',
      'landing.properties.emptyRegion.sub': 'Vuelve pronto, o contáctanos para otras ubicaciones.',
      'landing.badge.available': 'Disponible', 'landing.badge.unavailable': 'No Disponible',
      'landing.units': 'Unidades', 'landing.applyNow': 'Aplicar Ahora', 'landing.tenantLogin': 'Acceso Inquilinos',
      'landing.footer.quickLinks': 'Enlaces Rápidos', 'landing.footer.findProperty': 'Encuentra Tu Propiedad',
      'landing.footer.payRent': 'Pagar Renta en Línea', 'landing.footer.maintenance': 'Enviar Mantenimiento',
      'landing.footer.contact': 'Contacto', 'landing.footer.rights': 'Todos los derechos reservados.',
      'landing.login.title': 'Acceso Inquilinos', 'landing.login.email': 'Correo Electrónico',
      'landing.login.password': 'Contraseña', 'landing.login.signIn': 'Iniciar Sesión',
      'landing.login.registerLink': '¿Nuevo inquilino? Regístrate', 'landing.login.forgot': '¿Olvidaste tu contraseña?',
      'landing.login.activateHint': '🔑 <strong>¿Primera vez activando tu cuenta?</strong> Ingresa tu correo arriba y haz clic en <strong>¿Olvidaste tu contraseña?</strong> para recibir un enlace de activación nuevo.',
      'landing.register.title': 'Crear Cuenta', 'landing.register.subtitle': 'Tu cuenta será revisada por el administrador de la propiedad.',
      'landing.register.firstName': 'Nombre *', 'landing.register.lastName': 'Apellido *',
      'landing.register.email': 'Correo *', 'landing.register.password': 'Contraseña * (mín. 6 caracteres)',
      'landing.register.phone': 'Número de Teléfono', 'landing.register.unit': 'Número de Unidad',
      'landing.register.moveIn': 'Fecha de Mudanza', 'landing.register.submit': 'Enviar Registro',
      'landing.register.loginLink': '¿Ya tienes cuenta? Inicia Sesión',
      'landing.admin.title': 'Acceso Administrador', 'landing.admin.email': 'Correo', 'landing.admin.password': 'Contraseña',
      'landing.admin.signIn': 'Iniciar Sesión Admin', 'landing.admin.forgot': '¿Olvidaste tu contraseña?',

      'apply.nav.back': '← Volver al Portal',
      'apply.hero.eyebrow': 'Disponible Ahora', 'apply.hero.title': 'Encuentra Tu<br><em>Próximo Hogar</em>',
      'apply.hero.subtitle': 'Explora las propiedades disponibles y aplica en línea. Nuestro equipo revisa cada solicitud personalmente.',
      'apply.empty.title': 'No Hay Unidades Disponibles',
      'apply.empty.body': 'No tenemos unidades disponibles en este momento.<br>Vuelve pronto o contáctanos para unirte a la lista de espera.',
      'apply.card.available': 'Disponible', 'apply.card.availableUnits': 'Unidades Disponibles',
      'apply.card.totalUnits': 'unidades totales', 'apply.card.apply': 'Aplicar', 'apply.card.applyNow': 'Aplicar Ahora',
      'apply.card.unit': 'Unidad',
      'apply.modal.title': 'Solicitud de Alquiler', 'apply.modal.loading': 'Cargando…',
      'apply.success.title': 'Solicitud Enviada',
      'apply.success.body': '¡Gracias! Tu solicitud ha sido recibida y está en revisión. Nos pondremos en contacto en 2 a 5 días hábiles.',
      'apply.success.emailNote': 'Se ha enviado un correo de confirmación con tu divulgación de derechos de datos a tu correo electrónico.',
      'apply.success.appId': 'ID de Solicitud:', 'apply.close': 'Cerrar',
      'apply.step.you': 'Tú', 'apply.step.finances': 'Finanzas', 'apply.step.consent': 'Consentimiento',
      'apply.field.firstName': 'Nombre', 'apply.field.lastName': 'Apellido',
      'apply.field.email': 'Correo Electrónico', 'apply.field.emailHint': 'La confirmación y actualizaciones de tu solicitud se enviarán aquí.',
      'apply.field.phone': 'Número de Teléfono', 'apply.field.moveIn': 'Fecha de Mudanza Deseada',
      'apply.field.message': 'Mensaje para el Administrador de la Propiedad',
      'apply.field.messagePlaceholder': 'Cuéntanos un poco sobre ti o haz una pregunta…',
      'apply.finances.intro': 'Esta información se usa únicamente para evaluar tu capacidad de cumplir con las obligaciones de alquiler. Se almacena de forma segura y nunca se vende.',
      'apply.field.income': 'Ingreso Mensual Bruto ($)', 'apply.field.incomeHint': 'Antes de impuestos. Déjalo en blanco si prefieres no compartirlo.',
      'apply.field.employer': 'Empleador Actual', 'apply.field.employerHint': 'O "Trabajo independiente", "Jubilado", etc.',
      'apply.field.pets': 'Mascotas',
      'apply.pets.none': 'Sin mascotas', 'apply.pets.dogSmall': 'Perro (pequeño, menos de 25 lbs)',
      'apply.pets.dogLarge': 'Perro (grande, 25+ lbs)', 'apply.pets.cat': 'Gato',
      'apply.pets.other': 'Otra', 'apply.pets.multiple': 'Varias mascotas',
      'apply.finances.note': '<strong>Nota:</strong> Proporcionar información financiera falsa puede resultar en el rechazo inmediato de la solicitud y podría constituir fraude. Verificamos los ingresos en la etapa del contrato, no durante la revisión inicial.',
      'apply.privacy.title': '🔒 Cómo Usamos Tu Información',
      'apply.privacy.item1': 'Para evaluar tu solicitud de alquiler',
      'apply.privacy.item2': 'Para contactarte sobre el estado de tu solicitud',
      'apply.privacy.item3': 'Para verificar ingresos y referencias <em>solo si tu solicitud avanza</em>',
      'apply.privacy.footer': '<strong>No vendemos tu información personal.</strong> Los datos se almacenan de forma segura y se conservan durante 90 días para las solicitudes rechazadas. Puedes solicitar la eliminación en cualquier momento antes de firmar un contrato.',
      'apply.consent.dataTitle': 'Consiento la recopilación y uso de mis datos personales',
      'apply.consent.required': 'Obligatorio', 'apply.consent.optionalStage': 'Opcional en esta etapa',
      'apply.consent.dataBody': 'Autorizo a esta empresa de administración de propiedades a recopilar, almacenar y procesar la información personal que he proporcionado en este formulario con el fin de evaluar mi solicitud de alquiler.',
      'apply.consent.dataLegal': 'Tus datos se recopilan bajo los marcos de CCPA (California) y GDPR (si aplica). Tienes derecho a acceder, corregir y eliminar tus datos. El consentimiento queda registrado con fecha, hora y dirección IP.',
      'apply.consent.bgTitle': 'Autorizo una verificación de antecedentes y crédito',
      'apply.consent.bgBody': 'Si mi solicitud avanza, autorizo al propietario a obtener un informe de consumidor (verificación de antecedentes y/o crédito) de una agencia de informes de consumidores externa.',
      'apply.consent.bgLegal': 'Conservas tus derechos bajo la Ley Justa de Informes de Crédito (FCRA). Si se usa un informe para tomar una decisión adversa, recibirás un Aviso de Acción Adversa según lo exige la ley.',
      'apply.consent.termsTitle': 'Certifico que toda la información es precisa',
      'apply.consent.termsBody': 'Certifico bajo pena de perjurio que toda la información proporcionada en esta solicitud es verdadera y completa. Entiendo que proporcionar información falsa puede resultar en el rechazo inmediato o la terminación del arrendamiento.',
      'apply.consent.footerNote': 'Al enviar esta solicitud, tu consentimiento expreso queda registrado legalmente junto con la fecha, hora y dirección IP del envío, según lo exigen las regulaciones de privacidad aplicables.',
      'apply.nav.backBtn': '← Atrás', 'apply.nav.continue': 'Continuar →', 'apply.nav.submit': 'Enviar Solicitud',
      'apply.footer.dataQuestion': '¿Preguntas sobre tus datos? Contáctanos en',
      'apply.footer.emailFallback': 'el correo registrado', 'apply.footer.noSell': 'No vendemos información personal.',

      'tenant.nav.dashboard': 'Panel', 'tenant.nav.payments': 'Pagos',
      'tenant.nav.invoices': 'Facturas', 'tenant.nav.documents': 'Documentos',
      'tenant.nav.maintenance': 'Mantenimiento', 'tenant.nav.support': 'Soporte',
      'tenant.dashboard.recentPayments': 'Pagos Recientes', 'tenant.dashboard.leaseInfo': 'Información del Contrato',
      'tenant.payments.payRent': 'Pagar Renta', 'tenant.payments.autoPay': '🔁 Pagos Automáticos',
      'tenant.payments.history': 'Historial de Pagos',
      'tenant.invoices.title': 'Mis Facturas y Recibos',
      'tenant.documents.mine': 'Mis Documentos', 'tenant.documents.property': 'Documentos de la Propiedad',
      'tenant.maintenance.submit': 'Enviar Solicitud de Reparación', 'tenant.maintenance.mine': 'Mis Solicitudes',
      'tenant.support.send': 'Enviar un Mensaje', 'tenant.support.history': 'Historial de Mensajes',
      'tenant.support.features': '💡 Solicitudes de Funciones',

      'cookie.message': 'Usamos cookies para operar este sitio y procesar pagos de forma segura. Algunas son necesarias para el funcionamiento del sitio; otras nos ayudan a entender cómo se usa. Puedes aceptar o rechazar las cookies no esenciales.',
      'cookie.accept': 'Aceptar Todo', 'cookie.reject': 'Rechazar No Esenciales',
      'cookie.manage': 'Administrar Preferencias', 'cookie.necessaryOnly': 'Las cookies necesarias mantienen el sitio y los pagos funcionando y no se pueden desactivar.',
      'cookie.save': 'Guardar Preferencias',
    },
  };

  let currentLang = 'en';

  function t(key) {
    return (DICT[currentLang] && DICT[currentLang][key]) || DICT.en[key] || key;
  }

  function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.innerHTML = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    });
    document.documentElement.setAttribute('lang', currentLang);
    document.querySelectorAll('[data-lang-btn]').forEach(btn => {
      const isActive = btn.getAttribute('data-lang-btn') === currentLang;
      btn.style.fontWeight = isActive ? '700' : '400';
      btn.style.opacity = isActive ? '1' : '0.55';
    });
  }

  async function detectDefaultLanguage(knownCountry) {
    const saved = localStorage.getItem('siteLang');
    if (saved === 'en' || saved === 'es') return saved;
    const urlOverride = new URLSearchParams(window.location.search).get('lang');
    if (urlOverride === 'en' || urlOverride === 'es') return urlOverride;
    try {
      const country = knownCountry !== undefined ? knownCountry : await (async () => {
        const res = await fetch('/api/geo');
        return res.ok ? (await res.json()).country : null;
      })();
      if (country === 'CO') return 'es';
      if (country === 'US') return 'en';
    } catch (err) { /* fall through to default */ }
    return 'en';
  }

  function setLanguage(lang) {
    currentLang = (lang === 'es') ? 'es' : 'en';
    localStorage.setItem('siteLang', currentLang);
    applyTranslations();
  }

  // Injects a simple "EN | ES" toggle into the given container (by id).
  function renderToggle(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = `
      <button type="button" data-lang-btn="en" onclick="PublicI18N.setLanguage('en')" style="background:none;border:none;cursor:pointer;font-size:12px;letter-spacing:0.05em;color:inherit;padding:2px 4px;">EN</button>
      <span style="opacity:0.4;">|</span>
      <button type="button" data-lang-btn="es" onclick="PublicI18N.setLanguage('es')" style="background:none;border:none;cursor:pointer;font-size:12px;letter-spacing:0.05em;color:inherit;padding:2px 4px;">ES</button>
    `;
  }

  // toggleContainerId: id of an element to render the EN|ES toggle into (optional).
  // knownCountry: pass this if the host page already fetched /api/geo itself
  // (e.g. index.html uses it for property filtering too), to avoid a second
  // network round-trip. Omit it and this will fetch /api/geo itself.
  async function init(toggleContainerId, knownCountry) {
    currentLang = await detectDefaultLanguage(knownCountry);
    if (toggleContainerId) renderToggle(toggleContainerId);
    applyTranslations();
  }

  global.PublicI18N = { init, t, setLanguage, applyTranslations, renderToggle, getLang: () => currentLang };
})(window);
