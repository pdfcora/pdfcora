import CryptoKit
import Foundation

public enum PdfLicenseModule: String, CaseIterable, Sendable {
    case editing, forms, signing, redaction, ai
}

public enum PdfLicenseReason: String, Sendable {
    case noKey, malformed, badSignature, unsupportedVersion, revoked, expired, wrongApp
}

public enum PdfLicenseStatus: Sendable, Equatable {
    case licensed(customer: String, modules: Set<PdfLicenseModule>)
    case trial(reason: PdfLicenseReason, message: String)

    public func covers(_ module: PdfLicenseModule) -> Bool {
        if case .licensed(_, let modules) = self { return modules.contains(module) }
        return false
    }

    public var isTrial: Bool {
        if case .trial = self { return true }
        return false
    }
}

struct LicenseContext: Sendable {
    var publicKey: String
    var revoked: Set<String>
    var releaseDate: String
    var appIdentifier: String?
}

/// `pk1.<payload>.<signature>`, verified offline. See the licensing spec.
enum LicenseKey {
    static func evaluate(_ key: String?, context: LicenseContext) -> PdfLicenseStatus {
        guard let key = key?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty else {
            return .trial(reason: .noKey, message: "no license key set")
        }
        let malformed = PdfLicenseStatus.trial(reason: .malformed, message: "license key is malformed")
        let parts = key.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, parts[0] == "pk1",
              let payloadBytes = base64url(parts[1]), let signatureBytes = base64url(parts[2]),
              let payload = Payload(payloadBytes)
        else { return malformed }

        guard let keyBytes = base64url(context.publicKey),
              let publicKey = try? P256.Signing.PublicKey(x963Representation: keyBytes),
              let signature = try? P256.Signing.ECDSASignature(rawRepresentation: signatureBytes),
              publicKey.isValidSignature(signature, for: payloadBytes)
        else { return .trial(reason: .badSignature, message: "license key signature is invalid") }

        guard payload.v == 1 else {
            return .trial(reason: .unsupportedVersion, message: "license key version \(payload.v) is not supported by this SDK")
        }
        guard !context.revoked.contains(payload.id) else {
            return .trial(reason: .revoked, message: "license key \(payload.id) has been revoked")
        }
        guard context.releaseDate <= payload.expires else {
            return .trial(reason: .expired, message:
                "license key expired on \(payload.expires), before this SDK was released on \(context.releaseDate)")
        }
        guard let app = context.appIdentifier, payload.ios.contains(app) else {
            let listed = payload.ios.isEmpty ? "no iOS apps" : payload.ios.joined(separator: ", ")
            return .trial(reason: .wrongApp, message: "key is for \(listed), this app is \(context.appIdentifier ?? "unknown")")
        }
        let modules = Set(payload.modules.compactMap(PdfLicenseModule.init(rawValue:)))
        return .licensed(customer: payload.customer, modules: modules)
    }

    static func base64url(_ text: String) -> Data? {
        guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        switch standard.count % 4 {
        case 2: standard += "=="
        case 3: standard += "="
        case 1: return nil
        default: break
        }
        return Data(base64Encoded: standard)
    }

    private struct Payload {
        let v: Int
        let id: String
        let customer: String
        let modules: [String]
        let ios: [String]
        let expires: String

        init?(_ data: Data) {
            guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let v = object["v"] as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(),
                  let id = object["id"] as? String,
                  let customer = object["customer"] as? String,
                  let modules = object["modules"] as? [String],
                  let expires = object["expires"] as? String,
                  expires.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
            else { return nil }
            for list in ["ios", "android", "web"] where object[list] != nil && !(object[list] is [String]) { return nil }
            if let server = object["server"], CFGetTypeID(server as CFTypeRef) != CFBooleanGetTypeID() { return nil }
            self.v = v.intValue
            self.id = id
            self.customer = customer
            self.modules = modules
            self.ios = object["ios"] as? [String] ?? []
            self.expires = expires
        }
    }
}
