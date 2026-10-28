import XCTest
@testable import PDFCoraAI

#if canImport(FoundationModels)
import FoundationModels
#endif

final class AvailabilityTests: XCTestCase {

    func testOnlyAvailableIsUsable() {
        XCTAssertTrue(PdfAiAvailability.available.isUsable)
        XCTAssertFalse(PdfAiAvailability.downloadable.isUsable)
        XCTAssertFalse(PdfAiAvailability.downloading(progress: 0.5).isUsable)
        XCTAssertFalse(PdfAiAvailability.unavailable(.deviceNotEligible).isUsable)
    }

    #if canImport(FoundationModels)
    /// Apple reports two states; this vocabulary has four. The two it does not have are
    /// unreachable here, and that is the point of pinning it.
    @available(iOS 26.0, macOS 26.0, *)
    func testAppleStatesMapOntoOurs() throws {
        XCTAssertEqual(PdfAiAvailability(apple: .available), .available)
        XCTAssertEqual(PdfAiAvailability(apple: .unavailable(.deviceNotEligible)),
                       .unavailable(.deviceNotEligible))
        XCTAssertEqual(PdfAiAvailability(apple: .unavailable(.appleIntelligenceNotEnabled)),
                       .unavailable(.notEnabled))
        XCTAssertEqual(PdfAiAvailability(apple: .unavailable(.modelNotReady)),
                       .unavailable(.modelNotReady))
    }
    #endif

    /// The availability check must answer on every OS this package supports, including
    /// the ones with no framework at all.
    func testAvailabilityAnswersRatherThanCrashingOnAnyOS() {
        let state = AppleModel.availability()
        if #available(iOS 26.0, macOS 26.0, *) {
            // Whatever this simulator reports, it must be one of the four states.
            XCTAssertNotNil(state)
        } else {
            XCTAssertEqual(state, .unavailable(.platformUnsupported))
        }
    }

    /// Pins the SDK facts Phase 1 and Phase 3 are planned around.
    func testTheModelIsTextOnly() {
        XCTAssertFalse(AppleModel.acceptsImages,
                       "FoundationModels is text-only as of iOS 26.4; alt text has no Apple on-device route")
    }

    /// The budget is whatever the OS says, and a non-positive one is no budget.
    ///
    /// This is not hypothetical: an iOS 27 simulator reports `.available` with a
    /// `contextSize` of `0`. Reading 4096 out of the SDK's interface is misleading —
    /// that number is the back-deployment shim's body for OSes before 26.4, not what
    /// the live implementation returns.
    func testABudgetIsOnlyABudgetWhenItIsPositive() {
        if let tokens = AppleModel.contextTokens() {
            XCTAssertGreaterThan(tokens, 0)
        }
    }

    /// The trap this pins: availability alone does not mean the model can be prompted.
    func testPromptabilityNeedsBothAvailabilityAndABudget() {
        XCTAssertFalse(AppleModel.Reading(availability: .available, contextTokens: nil).isPromptable,
                       "available with no budget is not promptable — the simulator reports exactly this")
        XCTAssertFalse(AppleModel.Reading(availability: .unavailable(.notEnabled),
                                          contextTokens: 4096).isPromptable)
        XCTAssertTrue(AppleModel.Reading(availability: .available, contextTokens: 4096).isPromptable)
    }

    /// A reading is a snapshot, and decisions are made from the snapshot.
    ///
    /// The platform's answers move between calls: this suite caught a case where
    /// availability and the budget were sampled a few microseconds apart and disagreed.
    /// Querying twice inside one decision is the bug this shape prevents.
    func testAReadingIsInternallyConsistent() {
        let reading = AppleModel.read()
        if reading.isPromptable {
            XCTAssertTrue(reading.availability.isUsable)
            XCTAssertNotNil(reading.contextTokens)
        } else {
            XCTAssertTrue(!reading.availability.isUsable || reading.contextTokens == nil)
        }
    }
}
