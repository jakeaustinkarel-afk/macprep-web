package org.macprep.purchases;

import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;
import java.util.List;

@CapacitorPlugin(name = "MacprepPurchases")
public class MacprepPurchasesPlugin extends Plugin implements PurchasesUpdatedListener {
    private static final String PREMIUM_PRODUCT_ID = "org.macprep.app.full_access";
    private BillingClient billingClient;
    private PluginCall pendingPurchaseCall;

    @Override
    public void load() {
        billingClient = BillingClient.newBuilder(getContext())
            .setListener(this)
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder().enableOneTimeProducts().build()
            )
            .build();
    }

    @Override
    protected void handleOnDestroy() {
        if (billingClient != null) billingClient.endConnection();
    }

    @PluginMethod
    public void getProducts(PluginCall call) {
        withBillingClient(call, () -> queryProduct(call, product -> {
            JSObject serialized = serializeProduct(product);
            JSArray products = new JSArray();
            products.put(serialized);
            JSObject result = new JSObject();
            result.put("products", products);
            call.resolve(result);
        }));
    }

    @PluginMethod
    public void purchase(PluginCall call) {
        final String accountToken = call.getString("appAccountToken");
        if (!isUuid(accountToken)) {
            call.reject("A valid MACPrep account is required before purchasing.");
            return;
        }
        if (pendingPurchaseCall != null) {
            call.reject("A purchase is already in progress.");
            return;
        }
        withBillingClient(call, () -> queryProduct(call, product -> {
            pendingPurchaseCall = call;
            BillingFlowParams.ProductDetailsParams productParams =
                BillingFlowParams.ProductDetailsParams.newBuilder()
                    .setProductDetails(product)
                    .build();
            BillingFlowParams params = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(Collections.singletonList(productParams))
                .setObfuscatedAccountId(accountHash(accountToken))
                .build();
            BillingResult result = billingClient.launchBillingFlow(getActivity(), params);
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                pendingPurchaseCall = null;
                call.reject(billingMessage(result));
            }
        }));
    }

    @PluginMethod
    public void restorePurchases(PluginCall call) {
        withBillingClient(call, () -> {
            QueryPurchasesParams params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.INAPP)
                .build();
            billingClient.queryPurchasesAsync(params, (result, purchases) -> {
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    call.reject(billingMessage(result));
                    return;
                }
                JSArray transactions = new JSArray();
                for (Purchase purchase : purchases) {
                    if (isPremiumPurchase(purchase)) transactions.put(serializePurchase(purchase));
                }
                JSObject response = new JSObject();
                response.put("transactions", transactions);
                call.resolve(response);
            });
        });
    }

    @Override
    public void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
        PluginCall call = pendingPurchaseCall;
        pendingPurchaseCall = null;
        if (call == null) return;
        if (result.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            JSObject response = new JSObject();
            response.put("status", "cancelled");
            call.resolve(response);
            return;
        }
        if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
            call.reject(billingMessage(result));
            return;
        }
        if (purchases == null || purchases.isEmpty()) {
            call.reject("Google Play did not return a purchase.");
            return;
        }
        for (Purchase purchase : purchases) {
            if (isPremiumPurchase(purchase)) {
                call.resolve(serializePurchase(purchase));
                return;
            }
        }
        call.reject("The completed purchase did not contain MACPrep full access.");
    }

    private void withBillingClient(PluginCall call, Runnable action) {
        if (billingClient.isReady()) {
            action.run();
            return;
        }
        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(BillingResult result) {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) action.run();
                else call.reject(billingMessage(result));
            }

            @Override
            public void onBillingServiceDisconnected() {
                // A later request reconnects. This callback has no active call to reject.
            }
        });
    }

    private void queryProduct(PluginCall call, ProductCallback callback) {
        QueryProductDetailsParams.Product product = QueryProductDetailsParams.Product.newBuilder()
            .setProductId(PREMIUM_PRODUCT_ID)
            .setProductType(BillingClient.ProductType.INAPP)
            .build();
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
            .setProductList(Collections.singletonList(product))
            .build();
        billingClient.queryProductDetailsAsync(params, (result, detailsResult) -> {
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                call.reject(billingMessage(result));
                return;
            }
            List<ProductDetails> products = detailsResult.getProductDetailsList();
            if (products == null || products.isEmpty()) {
                call.reject("Full access is not available for purchase in Google Play yet.");
                return;
            }
            callback.onProduct(products.get(0));
        });
    }

    private boolean isPremiumPurchase(Purchase purchase) {
        return purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED
            && purchase.getProducts().contains(PREMIUM_PRODUCT_ID);
    }

    private JSObject serializeProduct(ProductDetails product) {
        JSObject result = new JSObject();
        result.put("productId", product.getProductId());
        result.put("displayName", product.getName());
        result.put("description", product.getDescription());
        if (product.getOneTimePurchaseOfferDetails() != null) {
            result.put("displayPrice", product.getOneTimePurchaseOfferDetails().getFormattedPrice());
        }
        return result;
    }

    private JSObject serializePurchase(Purchase purchase) {
        JSObject result = new JSObject();
        result.put("status", "purchased");
        result.put("purchaseToken", purchase.getPurchaseToken());
        result.put("productId", PREMIUM_PRODUCT_ID);
        return result;
    }

    private String billingMessage(BillingResult result) {
        String message = result.getDebugMessage();
        return message == null || message.isEmpty() ? "Google Play billing is unavailable right now." : message;
    }

    private boolean isUuid(String value) {
        return value != null && value.matches("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$");
    }

    private String accountHash(String accountId) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256")
                .digest(accountId.toLowerCase().getBytes(StandardCharsets.UTF_8));
            StringBuilder output = new StringBuilder(hash.length * 2);
            for (byte value : hash) output.append(String.format("%02x", Byte.toUnsignedInt(value)));
            return output.toString();
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable.", error);
        }
    }

    private interface ProductCallback {
        void onProduct(ProductDetails product);
    }
}
