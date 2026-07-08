CREATE OR REPLACE FUNCTION public.purchase_key_atomic(_telegram_id bigint, _price_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _user public.bot_users%ROWTYPE;
  _price public.product_prices%ROWTYPE;
  _product public.products%ROWTYPE;
  _override numeric;
  _unit numeric;
  _rank text;
  _shares int;
  _key public.product_stock_keys%ROWTYPE;
  _order_id uuid;
BEGIN
  SELECT * INTO _user FROM public.bot_users WHERE telegram_id = _telegram_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'user_missing'); END IF;

  SELECT * INTO _price FROM public.product_prices WHERE id = _price_id AND active = true;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'price_missing'); END IF;

  SELECT * INTO _product FROM public.products WHERE id = _price.product_id AND active = true;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'product_inactive'); END IF;

  SELECT price_usd INTO _override FROM public.user_price_overrides
    WHERE telegram_id = _telegram_id AND price_id = _price_id;

  IF _override IS NOT NULL THEN _unit := _override;
  ELSIF _price.sale_price_usd IS NOT NULL AND (_price.sale_ends_at IS NULL OR _price.sale_ends_at > now()) THEN _unit := _price.sale_price_usd;
  ELSE _unit := _price.price_usd; END IF;

  _rank := COALESCE(_user.rank::text, 'gold');
  IF _rank IN ('pro','platinum') THEN _unit := round((_unit * 0.995)::numeric, 2);
  ELSIF _rank IN ('leyenda','diamond') THEN _unit := round((_unit * 0.99)::numeric, 2);
  ELSIF _rank = 'elite' THEN
    IF abs(_unit - 30) < 0.005 THEN _unit := 25; ELSE _unit := round((_unit * 0.99)::numeric, 2); END IF;
  ELSE _unit := round(_unit::numeric, 2); END IF;

  _shares := COALESCE(_user.shares_count, 0);
  IF _shares >= 30 THEN _unit := greatest(0, round((_unit - 1)::numeric, 2)); END IF;

  IF COALESCE(_user.balance, 0) < _unit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance', 'need', _unit, 'have', COALESCE(_user.balance, 0));
  END IF;

  SELECT * INTO _key FROM public.product_stock_keys
    WHERE price_id = _price_id AND used = false
    ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'out_of_stock'); END IF;

  UPDATE public.bot_users SET balance = balance - _unit WHERE id = _user.id AND balance >= _unit;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance', 'need', _unit, 'have', COALESCE(_user.balance, 0));
  END IF;

  INSERT INTO public.orders(user_id, telegram_id, product_id, price_id, keys_qty, total_usd, status, paid_with_balance, order_type)
  VALUES (_user.id, _telegram_id, _product.id, _price.id, 1, _unit, 'delivered'::order_status, true, 'purchase')
  RETURNING id INTO _order_id;

  INSERT INTO public.order_keys(order_id, user_id, key_value) VALUES (_order_id, _user.id, _key.key_value);

  DELETE FROM public.product_stock_keys WHERE id = _key.id;

  RETURN jsonb_build_object('ok', true, 'order_id', _order_id, 'key_value', _key.key_value,
    'unit_usd', _unit, 'new_balance', COALESCE(_user.balance, 0) - _unit,
    'product_name', _product.name, 'duration_label', _price.duration_label);
END;
$function$;

CREATE OR REPLACE FUNCTION public.purchase_manual_atomic(_telegram_id bigint, _price_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _user public.bot_users%ROWTYPE;
  _price public.product_prices%ROWTYPE;
  _product public.products%ROWTYPE;
  _override numeric;
  _unit numeric;
  _rank text;
  _shares int;
  _order_id uuid;
BEGIN
  SELECT * INTO _user FROM public.bot_users WHERE telegram_id = _telegram_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'user_missing'); END IF;

  SELECT * INTO _price FROM public.product_prices WHERE id = _price_id AND active = true;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'price_missing'); END IF;

  SELECT * INTO _product FROM public.products WHERE id = _price.product_id AND active = true;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'product_inactive'); END IF;

  SELECT price_usd INTO _override FROM public.user_price_overrides
    WHERE telegram_id = _telegram_id AND price_id = _price_id;

  IF _override IS NOT NULL THEN _unit := _override;
  ELSIF _price.sale_price_usd IS NOT NULL AND (_price.sale_ends_at IS NULL OR _price.sale_ends_at > now()) THEN _unit := _price.sale_price_usd;
  ELSE _unit := _price.price_usd; END IF;

  _rank := COALESCE(_user.rank::text, 'gold');
  IF _rank IN ('pro','platinum') THEN _unit := round((_unit * 0.995)::numeric, 2);
  ELSIF _rank IN ('leyenda','diamond') THEN _unit := round((_unit * 0.99)::numeric, 2);
  ELSIF _rank = 'elite' THEN
    IF abs(_unit - 30) < 0.005 THEN _unit := 25; ELSE _unit := round((_unit * 0.99)::numeric, 2); END IF;
  ELSE _unit := round(_unit::numeric, 2); END IF;

  _shares := COALESCE(_user.shares_count, 0);
  IF _shares >= 30 THEN _unit := greatest(0, round((_unit - 1)::numeric, 2)); END IF;

  IF COALESCE(_user.balance, 0) < _unit THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance', 'need', _unit, 'have', COALESCE(_user.balance, 0));
  END IF;

  UPDATE public.bot_users SET balance = balance - _unit WHERE id = _user.id AND balance >= _unit;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance', 'need', _unit, 'have', COALESCE(_user.balance, 0));
  END IF;

  INSERT INTO public.orders(user_id, telegram_id, product_id, price_id, keys_qty, total_usd, status, paid_with_balance, order_type)
  VALUES (_user.id, _telegram_id, _product.id, _price.id, 1, _unit, 'pending_approval'::order_status, true, 'purchase')
  RETURNING id INTO _order_id;

  RETURN jsonb_build_object('ok', true, 'order_id', _order_id, 'unit_usd', _unit,
    'new_balance', COALESCE(_user.balance, 0) - _unit,
    'product_name', _product.name, 'duration_label', _price.duration_label);
END;
$function$;

UPDATE public.payment_methods SET active = false;

INSERT INTO public.payment_methods (country_code, country_name, method_name, holder_name, account_info, currency, usd_rate, active, sort_order, body_raw) VALUES
('AR','Argentina','MERCADO PAGO','Jeremías Velozo','jerevelozo','ARS',1600,true,10,
$$💳 Métodos De Pago - Argentina 🇦🇷

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 16,000.00 ARS

🏦 ✅ MERCADO PAGO
🪪 Nombre: Jeremías Velozo
📋 Alias: jerevelozo
💵 Total: 16,000.00 ARS$$),
('BR','Brasil','CHAVE PIX','Gabriela Lírio','vianahiago1997@gmail.com','BRL',7,true,10,
$$💳 Métodos De Pago - Brasil 🇧🇷

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 70.00 BRL

🏦 ✅ CHAVE PIX
🪪 Nombre: Gabriela Lírio
📋 Correo: vianahiago1997@gmail.com
💵 Total: 70.00 BRL$$),
('CL','Chile','CUENTA RUT','Angel Muñoz','23152118-6','CLP',1000,true,10,
$$💳 Métodos De Pago - Chile 🇨🇱

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 10,000.00 CLP

🏦 ✅ CUENTA RUT
🪪 Nombre: Angel Muñoz
📋 Número: 23152118-6
💵 Total: 10,000.00 CLP$$),
('CO','Colombia','NEQUI','Brenda Ramirez','3118802212','COP',4000,true,10,
$$💳 Métodos De Pago - Colombia 🇨🇴

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 40,000.00 COP

🏦 ✅ NEQUI
🪪 Nombre: Brenda Ramirez
📋 Número: 3118802212
💵 Total: 40,000.00 COP$$),
('US','Estados Unidos','ZELLE','Jesús Oliva','6673781363','USD',1,true,10,
$$💳 Métodos De Pago - Estados Unidos 🇺🇸

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 10.00 USD

🏦 ✅ ZELLE
🪪 Nombre: Jesús Oliva
📋 Número: 6673781363
💵 Total: 10.00 USD$$),
('EC','Ecuador','BANCO PICHINCHA','Andy Rodriguez','2210169007','USD',1,true,10,
$$💳 Métodos De Pago - Ecuador 🇪🇨

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 10.00 USD

🏦 ✅ BANCO PICHINCHA
🪪 Nombre: Andy Rodriguez
📋 Número: 2210169007
💵 Total: 10.00 USD$$),
('GT','Guatemala','BANRURAL','José Barrientos','4068274165','GTQ',8,true,10,
$$💳 Métodos De Pago - Guatemala 🇬🇹

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 80.00 GTQ

🏦 ✅ BANRURAL
🪪 Nombre: José Barrientos
📋 Número: 4068274165
💵 Total: 80.00 GTQ$$),
('HN','Honduras','BAC HONDURAS','Kevin Bautista','753040931','HNL',30,true,10,
$$💳 Métodos De Pago - Honduras 🇭🇳

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 300.00 HNL

🏦 ✅ BAC HONDURAS
🪪 Nombre: Kevin Bautista
📋 Número: 753040931
💵 Total: 300.00 HNL$$),
('MX','México','NU BANK (OXXO)','David Peña','5195379974135422','MXN',20,true,10,
$$💳 Métodos De Pago - México 🇲🇽

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 200.00 MXN

🏦 ✅ NU BANK (OXXO)
🪪 Nombre: David Peña
📋 Número: 5195379974135422
💵 Total: 200.00 MXN$$),
('MX','México','ALBO (TRANSFERENCIA)','David Peña','721180100034496637','MXN',20,true,20,
$$🏦 ✅ ALBO (TRANSFERENCIA)
🪪 Nombre: David Peña
📋 Número: 721180100034496637
💵 Total: 200.00 MXN$$),
('NI','Nicaragua','BANCO CORDOBAS','Nahomi Flores','363278672','NIO',40,true,10,
$$💳 Métodos De Pago - Nicaragua 🇳🇮

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 400.00 NIO

🏦 ✅ BANCO CORDOBAS
🪪 Nombre: Nahomi Flores
📋 Número: 363278672
💵 Total: 400.00 NIO$$),
('PA','Panamá','YAPPY','Michael Grant','6619-8244','PAB',1.2,true,10,
$$💳 Métodos De Pago - Panamá 🇵🇦

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 12.00 PAB

🏦 ✅ YAPPY
🪪 Nombre: Michael Grant
📋 Número: 6619-8244
💵 Total: 12.00 PAB$$),
('PE','Perú','YAPE - ✅ PLIN - ✅ AGORA','Jaime Guevara','928574897','PEN',3.6,true,10,
$$💳 Métodos De Pago - Perú 🇵🇪

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 36.00 PEN

🏦 ✅ YAPE - ✅ PLIN - ✅ AGORA
🪪 Nombre: Jaime Guevara
📋 Número: 928574897
💵 Total: 36.00 PEN$$),
('UY','Uruguay','PREX','Jaime Guevara','14591044','PEN',3.6,true,10,
$$💳 Métodos De Pago - Uruguay 🇺🇾

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 36.00 PEN

🏦 ✅ PREX
🪪 Nombre: Jaime Guevara
📋 Cuenta: 14591044
💵 Total: 36.00 PEN$$),
('VE','Venezuela','PAGO MÓVIL 0102','José V-30377305','04248585383','VES',800,true,10,
$$💳 Métodos De Pago - Venezuela 🇻🇪

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 8,000.00 VES

🏦 ✅ PAGO MÓVIL 0102
🪪 Nombre: José V-30377305
📋 Número: 04248585383
💵 Total: 8,000.00 VES$$),
('VN','Vietnam','MOMO','Kiên Út Ninh','0378022091','VND',28000,true,10,
$$💳 Métodos De Pago - Vietnam 🇻🇳

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 280,000.00 VND

🏦 ✅ MOMO
🪪 Nombre: Kiên Út Ninh
📋 Número: 0378022091
💵 Total: 280,000.00 VND$$),
('GL','Global','BINANCE','MrFresaYT','181500068','USDT',1,true,10,
$$💳 Métodos De Pago - Global 🌎

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 10.00 USDT

🏦 ✅ BINANCE
🪪 Nombre: MrFresaYT
📋 ID: 181500068
💵 Total: 10.00 USDT$$),
('GL','Global','SKRILL','MrFresaYT','mrfresayt@gmail.com','USDT',1,true,20,
$$🏦 ✅ SKRILL
🪪 Nombre: MrFresaYT
📋 Correo: mrfresayt@gmail.com
💵 Total: 10.00 USDT$$),
('DO','República Dominicana','BANCO BANRESERVAS','Yerlinson Chávez','9608823784','DOP',60,true,10,
$$💳 Métodos De Pago - República Dominicana 🇩🇴

🆔 Recarga: TP0
💰 Monto: 10.00 USD
🧾 Pagas: 600.00 DOP

🏦 ✅ BANCO BANRESERVAS
🪪 Nombre: Yerlinson Chávez
📋 Número: 9608823784
💵 Total: 600.00 DOP$$);
