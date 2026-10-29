import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// FoundationNetworking lacks AsyncBytes in the supported toolchain. The delegate
// enforces the same limit while receiving, not after allocating an unbounded body.
//
// Every download used to create its own URLSession and invalidate it from its own
// didComplete callback. On Linux that releases the session's curl multi handle while
// the session's work queue still references it, and the process aborts with
// "_MultiHandle deallocated with non-zero retain count". Downloads now share one
// long-lived delegate session per caller session that is never invalidated, and the
// router below keeps each task's limit and continuation.
private final class BoundedDownloadRouter: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = BoundedDownloadRouter()
    private struct Transfer {
        let limit: Int
        let continuation: CheckedContinuation<(Data, URLResponse), Error>
        var data = Data()
        var response: URLResponse?
        var oversized = false
    }
    private let lock = NSLock()
    // The caller's session is retained with its delegate session so the key cannot be reused.
    private var sessions: [ObjectIdentifier: (base: URLSession, session: URLSession)] = [:]
    private var transfers: [ObjectIdentifier: Transfer] = [:]

    private func session(for base: URLSession) -> URLSession {
        lock.lock(); defer { lock.unlock() }
        if let entry = sessions[ObjectIdentifier(base)] { return entry.session }
        let session = URLSession(configuration: base.configuration, delegate: self, delegateQueue: nil)
        sessions[ObjectIdentifier(base)] = (base, session)
        return session
    }
    func start(_ request: URLRequest, base: URLSession, limit: Int,
               continuation: CheckedContinuation<(Data, URLResponse), Error>) -> URLSessionDataTask {
        let task = session(for: base).dataTask(with: request)
        lock.lock(); transfers[ObjectIdentifier(task)] = Transfer(limit: limit, continuation: continuation); lock.unlock()
        task.resume()
        return task
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock()
        let id = ObjectIdentifier(dataTask)
        let oversized = transfers[id].map { response.expectedContentLength > $0.limit } ?? true
        transfers[id]?.response = response; transfers[id]?.oversized = oversized
        lock.unlock()
        completionHandler(oversized ? .cancel : .allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive bytes: Data) {
        lock.lock()
        let id = ObjectIdentifier(dataTask)
        var exceeded = false
        if let transfer = transfers[id] {
            if !transfer.oversized && bytes.count <= transfer.limit - transfer.data.count { transfers[id]?.data.append(bytes) }
            else { transfers[id]?.oversized = true; exceeded = true }
        }
        lock.unlock()
        if exceeded { dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let transfer = transfers.removeValue(forKey: ObjectIdentifier(task)); lock.unlock()
        guard let transfer else { return }
        if transfer.oversized { transfer.continuation.resume(throwing: URLError(.dataLengthExceedsMaximum)) }
        else if let error { transfer.continuation.resume(throwing: error) }
        else if let response = transfer.response { transfer.continuation.resume(returning: (transfer.data, response)) }
        else { transfer.continuation.resume(throwing: URLError(.badServerResponse)) }
    }
}

/// Cancellation may arrive before the task exists; the handle remembers it.
private final class BoundedDownloadHandle: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionDataTask?
    private var cancelled = false
    func start(_ create: () -> URLSessionDataTask?, else reject: () -> Void) {
        lock.lock(); defer { lock.unlock() }
        if cancelled { reject(); return }
        task = create()
    }
    func cancel() {
        lock.lock(); cancelled = true; let task = task; lock.unlock(); task?.cancel()
    }
}

extension URLSession {
    func boundedData(for request: URLRequest, limit: Int) async throws -> (Data, URLResponse) {
        let handle = BoundedDownloadHandle()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                handle.start({ BoundedDownloadRouter.shared.start(request, base: self, limit: limit, continuation: continuation) },
                             else: { continuation.resume(throwing: CancellationError()) })
            }
        } onCancel: { handle.cancel() }
    }
}
