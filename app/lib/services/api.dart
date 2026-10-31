import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../config.dart';

/// A failure in plain words, ready to show. Never a stack trace, never a fake success.
class ApiError implements Exception {
  final String message;
  final int? status;
  const ApiError(this.message, [this.status]);
  @override
  String toString() => message;
}

/// Everything the app asks of the server goes through here. The server decides; the app shows its answer.
class Api {
  static final http.Client _client = http.Client();
  static http.Client? testClient; // widget tests swap this for a fake server

  static http.Client get _c => testClient ?? _client;

  static Future<dynamic> get(String path, {Map<String, String>? query, Duration timeout = const Duration(seconds: 25)}) =>
      _send(() => _c.get(apiUri(path, query)), timeout);

  static Future<dynamic> postJson(String path, [Map<String, dynamic>? body, Map<String, String>? query, Duration timeout = const Duration(seconds: 40)]) =>
      _send(() => _c.post(apiUri(path, query), headers: {'Content-Type': 'application/json'}, body: jsonEncode(body ?? {})), timeout);

  static Future<dynamic> postBytes(String path, Uint8List bytes, String contentType, {Map<String, String>? query, Duration timeout = const Duration(seconds: 90)}) =>
      _send(() => _c.post(apiUri(path, query), headers: {'Content-Type': contentType}, body: bytes), timeout);

  static Future<dynamic> delete(String path, {Duration timeout = const Duration(seconds: 25)}) => _send(() => _c.delete(apiUri(path)), timeout);

  static Future<dynamic> _send(Future<http.Response> Function() go, Duration timeout) async {
    http.Response r;
    try {
      r = await go().timeout(timeout);
    } on TimeoutException {
      throw const ApiError('Maya is taking too long to answer. Please try again in a moment.');
    } on SocketException {
      throw const ApiError('Cannot reach Maya. Please check the internet connection and try again.');
    } on http.ClientException {
      throw const ApiError('Cannot reach Maya. Please check the internet connection and try again.');
    } on HandshakeException {
      throw const ApiError('A secure connection to Maya could not be made. Please try again.');
    }
    dynamic body;
    try {
      body = r.body.isEmpty ? null : jsonDecode(utf8.decode(r.bodyBytes));
    } catch (_) {
      body = null;
    }
    if (r.statusCode < 200 || r.statusCode >= 300) {
      final msg = body is Map && body['error'] is String ? body['error'] as String : 'Something went wrong (${r.statusCode}). Please try again.';
      throw ApiError(msg, r.statusCode);
    }
    return body;
  }

  /// Absolute address for a media path the server gave (a path under /api/chat/ID/media/).
  static String media(String p) => p.startsWith('http') ? p : kServer + p;
}
