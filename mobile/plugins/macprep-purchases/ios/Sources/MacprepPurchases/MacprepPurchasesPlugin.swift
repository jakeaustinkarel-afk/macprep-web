import Capacitor
import StoreKit

@objc(MacprepPurchasesPlugin)
public class MacprepPurchasesPlugin: CAPPlugin, CAPBridgedPlugin {
    private static let premiumProductId = "org.macprep.app.full_access"

    public let identifier = "MacprepPurchasesPlugin"
    public let jsName = "MacprepPurchases"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restorePurchases", returnType: CAPPluginReturnPromise)
    ]

    @objc public func getCapabilities(_ call: CAPPluginCall) {
        call.resolve([
            "bridgeVersion": 2,
            "productIds": [Self.premiumProductId],
            "supportsPurchase": true,
            "supportsRestore": true
        ])
    }

    @objc public func getProducts(_ call: CAPPluginCall) {
        Task {
            do {
                let product = try await premiumProduct()
                call.resolve([
                    "products": [[
                        "productId": product.id,
                        "displayName": product.displayName,
                        "description": product.description,
                        "displayPrice": product.displayPrice
                    ]]
                ])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc public func purchase(_ call: CAPPluginCall) {
        guard let rawAccountToken = call.getString("appAccountToken"),
              let accountToken = UUID(uuidString: rawAccountToken) else {
            call.reject("A valid MACPrep account is required before purchasing.")
            return
        }

        Task {
            do {
                let product = try await premiumProduct()
                let result = try await product.purchase(options: [.appAccountToken(accountToken)])
                switch result {
                case .success(let verification):
                    let transaction = try verifiedTransaction(from: verification)
                    call.resolve(transactionPayload(transaction))
                case .pending:
                    call.resolve(["status": "pending"])
                case .userCancelled:
                    call.resolve(["status": "cancelled"])
                @unknown default:
                    call.reject("The purchase could not be completed.")
                }
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc public func finishTransaction(_ call: CAPPluginCall) {
        guard let rawTransactionId = call.getString("transactionId"),
              let transactionId = UInt64(rawTransactionId) else {
            call.reject("A valid Apple transaction is required.")
            return
        }

        Task {
            do {
                for await verification in Transaction.unfinished {
                    let transaction = try verifiedTransaction(from: verification)
                    guard transaction.id == transactionId,
                          transaction.productID == Self.premiumProductId else { continue }
                    await transaction.finish()
                    call.resolve(["finished": true])
                    return
                }
                call.resolve(["finished": false])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc public func restorePurchases(_ call: CAPPluginCall) {
        Task {
            do {
                // StoreKit prompts for authentication if needed and refreshes the local
                // entitlement cache before it is read below.
                try await AppStore.sync()
                var transactions = [[String: Any]]()
                for await verification in Transaction.currentEntitlements {
                    let transaction = try verifiedTransaction(from: verification)
                    guard transaction.productID == Self.premiumProductId,
                          transaction.revocationDate == nil else { continue }
                    transactions.append(transactionPayload(transaction))
                }
                call.resolve(["transactions": transactions])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    private func premiumProduct() async throws -> Product {
        let products = try await Product.products(for: [Self.premiumProductId])
        guard let product = products.first else {
            throw StoreError.productUnavailable
        }
        return product
    }

    private func verifiedTransaction(
        from result: VerificationResult<Transaction>
    ) throws -> Transaction {
        switch result {
        case .verified(let transaction):
            return transaction
        case .unverified:
            throw StoreError.unverifiedTransaction
        }
    }

    private func transactionPayload(_ transaction: Transaction) -> [String: Any] {
        [
            "status": "purchased",
            "transactionId": String(transaction.id),
            "originalTransactionId": String(transaction.originalID),
            "productId": transaction.productID
        ]
    }

    private enum StoreError: LocalizedError {
        case productUnavailable
        case unverifiedTransaction

        var errorDescription: String? {
            switch self {
            case .productUnavailable:
                return "Full access is not available for purchase in the App Store yet."
            case .unverifiedTransaction:
                return "Apple could not verify this purchase."
            }
        }
    }
}
