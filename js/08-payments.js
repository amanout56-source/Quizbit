/*
 * QuizBIT Payment Module — Razorpay Standard Checkout
 * Frontend only. NEVER put Razorpay secret/service-role keys here.
 *
 * Server functions expected:
 *   create-payment-order
 *   verify-payment
 *   get-entitlement
 */
(function () {
  "use strict";

  const CONFIG = Object.freeze({
    checkoutUrl: "https://checkout.razorpay.com/v1/checkout.js",
    currency: "INR",
    themeColor: "#c9a227", // QuizBIT gold accent
    functions: Object.freeze({
      createOrder: "create-payment-order",
      verify: "verify-payment",
      entitlement: "get-entitlement"
    }),
    timeoutMs: 20000,
    entitlementPollMs: 2500,
    entitlementPollAttempts: 8
  });

  const PRODUCTS = Object.freeze({
    "top-200-pyq": Object.freeze({
      name: "Top 200 Curated PYQs",
      description: "Curated previous-year questions for focused revision"
    }),
    "top-1000-revision": Object.freeze({
      name: "Top 1000 Most Important Questions",
      description: "Complete-syllabus revision set for the final phase"
    })
  });

  const state = { busy: false, activeOrder: null, scriptPromise: null };

  function getSupabase() {
    if (typeof supabaseClient !== "undefined" && supabaseClient) return supabaseClient;
    throw new Error("QuizBIT Supabase client is unavailable.");
  }

  async function user() {
    const { data, error } = await getSupabase().auth.getUser();
    if (error) throw error;
    return data?.user || null;
  }

  async function fn(name, body = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
    try {
      const { data, error } = await getSupabase().functions.invoke(name, { body });
      if (error) throw error;
      if (data?.ok === false) throw new Error(data.message || "Payment request rejected.");
      return data || {};
    } finally {
      clearTimeout(timer);
    }
  }

  function toast(message) {
    if (typeof window.toast === "function") return window.toast(message);
    const el = document.getElementById("toast");
    if (el) {
      el.textContent = message;
      el.classList.add("show");
      setTimeout(() => el.classList.remove("show"), 2600);
    } else console.log("[QuizBIT Payment]", message);
  }

  function emit(name, detail = {}) {
    try {
      window.dispatchEvent(new CustomEvent("quizbit:payment:" + name, { detail }));
    } catch (_) {}
  }

  function product(id) {
    const key = String(id || "").trim();
    if (!PRODUCTS[key]) throw new Error("This QuizBIT product is unavailable.");
    return key;
  }

  function loadCheckout() {
    if (window.Razorpay) return Promise.resolve(window.Razorpay);
    if (state.scriptPromise) return state.scriptPromise;

    state.scriptPromise = new Promise((resolve, reject) => {
      const old = document.querySelector('script[data-quizbit-razorpay="1"]');
      if (old) {
        old.addEventListener("load", () => resolve(window.Razorpay));
        old.addEventListener("error", () => reject(new Error("Unable to load Razorpay Checkout.")));
        return;
      }

      const s = document.createElement("script");
      s.src = CONFIG.checkoutUrl;
      s.async = true;
      s.dataset.quizbitRazorpay = "1";
      s.onload = () => window.Razorpay
        ? resolve(window.Razorpay)
        : reject(new Error("Razorpay Checkout loaded incorrectly."));
      s.onerror = () => reject(new Error("Unable to load Razorpay Checkout."));
      document.head.appendChild(s);
    });

    return state.scriptPromise;
  }

  async function waitForAccess(productId) {
    for (let i = 0; i < CONFIG.entitlementPollAttempts; i++) {
      try {
        const r = await fn(CONFIG.functions.entitlement, { product_id: productId });
        if (r.entitled === true || r.has_access === true) return r;
      } catch (_) {}
      if (i < CONFIG.entitlementPollAttempts - 1)
        await new Promise(r => setTimeout(r, CONFIG.entitlementPollMs));
    }
    return { entitled: false };
  }

  async function verify(response, productId) {
    return fn(CONFIG.functions.verifyPayment, {
      razorpay_payment_id: response.razorpay_payment_id,
      razorpay_order_id: response.razorpay_order_id,
      razorpay_signature: response.razorpay_signature,
      product_id: productId
    });
  }

  async function openCheckout(productId, order, currentUser) {
    await loadCheckout();

    if (!order?.order_id || !order?.key_id || !Number(order.amount))
      throw new Error("Payment order response is incomplete.");

    if (String(order.product_id) !== productId)
      throw new Error("Payment product mismatch.");

    const checkout = new window.Razorpay({
      key: order.key_id,
      amount: Number(order.amount),
      currency: order.currency || CONFIG.currency,
      name: "QuizBIT",
      description: order.description || PRODUCTS[productId].description,
      order_id: order.order_id,

      handler: async function (response) {
        emit("checkout-success-callback", response);

        try {
          const result = await verify(response, productId);

          if (result.entitled === true) {
            toast("Payment confirmed. Premium access unlocked.");
            emit("success", result);
            return;
          }

          const access = await waitForAccess(productId);
          if (access.entitled || access.has_access) {
            toast("Payment confirmed. Premium access unlocked.");
            emit("success", access);
          } else {
            toast("Payment received, but access is still being confirmed. Please refresh shortly.");
            emit("pending-confirmation", {
              productId,
              paymentId: response.razorpay_payment_id,
              orderId: response.razorpay_order_id
            });
          }
        } catch (error) {
          console.error("QuizBIT payment verification failed:", error);
          toast("We couldn't confirm the payment yet. Your payment may still be processing.");
          emit("verification-error", {
            productId,
            paymentId: response.razorpay_payment_id,
            orderId: response.razorpay_order_id,
            error: error?.message || String(error)
          });
        } finally {
          state.busy = false;
          state.activeOrder = null;
        }
      },

      modal: {
        ondismiss: function () {
          state.busy = false;
          state.activeOrder = null;
          emit("dismissed", { productId });
        }
      },

      prefill: {
        name: currentUser.user_metadata?.full_name || "",
        email: currentUser.email || ""
      },

      notes: { quizbit_product_id: productId },
      theme: { color: CONFIG.themeColor }
    });

    checkout.on("payment.failed", function (response) {
      state.busy = false;
      state.activeOrder = null;
      const e = response?.error || {};
      toast(e.description ? "Payment failed: " + e.description : "Payment failed. No premium access was granted.");
      emit("failed", { productId, error: e });
    });

    state.activeOrder = { productId, orderId: order.order_id };
    checkout.open();
  }

  async function buy(productId, options = {}) {
    if (state.busy) {
      toast("A payment is already being processed.");
      return { ok: false, reason: "already_busy" };
    }

    let id;
    try { id = product(productId); }
    catch (e) { toast(e.message); return { ok: false, reason: "invalid_product" }; }

    state.busy = true;
    emit("started", { productId: id });

    try {
      const currentUser = await user();
      if (!currentUser) {
        state.busy = false;
        if (typeof options.onAuthRequired === "function") options.onAuthRequired();
        else toast("Please sign in before purchasing.");
        return { ok: false, reason: "not_authenticated" };
      }

      // Only product_id goes to the server. Price is NEVER trusted from the browser.
      const order = await fn(CONFIG.functions.createOrder, { product_id: id });

      if (String(order.currency || "INR") !== CONFIG.currency)
        throw new Error("Unsupported payment currency.");

      await openCheckout(id, order, currentUser);
      return { ok: true, orderId: order.order_id };
    } catch (e) {
      state.busy = false;
      state.activeOrder = null;
      toast(e?.name === "AbortError" ? "Payment service timed out. Please try again." : (e.message || "Unable to start payment."));
      emit("start-error", { productId: id, error: e?.message || String(e) });
      return { ok: false, reason: "start_error", error: e?.message || String(e) };
    }
  }

  async function hasAccess(productId) {
    const id = product(productId);
    if (!(await user())) return false;
    const r = await fn(CONFIG.functions.entitlement, { product_id: id });
    return r.entitled === true || r.has_access === true;
  }

  function renderPurchaseButton({ productId, label = "Buy now", className = "btn btn-solid qb-payment-button", onAuthRequired } = {}) {
    const id = product(productId);
    const b = document.createElement("button");
    b.type = "button";
    b.className = className;
    b.textContent = label;
    b.addEventListener("click", async () => {
      const original = b.textContent;
      b.disabled = true;
      b.textContent = "Starting…";
      try { await buy(id, { onAuthRequired }); }
      finally {
        if (!state.busy) { b.disabled = false; b.textContent = original; }
      }
    });
    return b;
  }

  window.QBPayments = Object.freeze({
    config: CONFIG,
    products: PRODUCTS,
    buy,
    hasAccess,
    renderPurchaseButton,
    get state() { return Object.freeze({ busy: state.busy, activeOrder: state.activeOrder }); }
  });
})();
