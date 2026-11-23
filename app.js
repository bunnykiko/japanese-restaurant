require('dotenv').config();

const express = require('express');
const session = require('express-session');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const http = require('http');
const { Server } = require('socket.io');

const app = express();

const server = http.createServer(app);
const io = new Server(server);

const port = process.env.PORT || 3000;

const uploadDir = 'public/uploads';

const DELIVERY_COST = 150;
const FREE_DELIVERY_THRESHOLD = 699;
const PICKUP_DISCOUNT_PERCENT = 7;

if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

// настройка хранилища (где и как сохранять)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Создаем уникальное имя файла
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = path.extname(file.originalname);
        cb(null, 'product-' + uniqueSuffix + extension);
    }
});

// Фильтр файлов
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
        cb(null, true);
    } else {
        cb(new Error('Недопустимый тип файла! Разрешены только изображения.'), false);
    }
};

// middleware 'upload'
const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 1024 * 1024 * 5 } // Лимит размера файла 5 МБ
});

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => {
  console.log('Connected to PostgreSQL database successfully!');
});

pool.on('error', (err) => {
  console.error('Ошибка пула подключений PostgreSQL:', {
    error: err.message,
    stack: err.stack
  });
  process.exit(1); 
});

async function sqlQuery(text, params) {
  const client = await pool.connect();
  try {
    const result = await client.query(text, params);
    return result;
  } catch (error) {
    console.error('Ошибка SQL запроса:', {
      query: text,
      params: params,
      error: error.message,
    });
    throw error;
  } finally {
    client.release();
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true })); 
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: 'my_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 часа
}));

app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

app.use((req, res, next) => {
    let totalCount = 0;
    if (req.session.cart) {
        totalCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);
    }
    res.locals.cartCount = totalCount;
    next();
});

app.use(async (req, res, next) => {
  try {
    const categoriesResult = await sqlQuery('SELECT name, slug FROM categories ORDER BY order_num');
    res.locals.rollCategories = categoriesResult.rows;
  } catch (error) {
    console.error('Ошибка категорий:', error);
    res.locals.rollCategories = [];
  }
  next(); 
});

function checkRole(allowedRoles) {
    return (req, res, next) => {
        if (!req.session.user || !allowedRoles.includes(req.session.user.role)) {
            return res.redirect('/staff/login');
        }
        next();
    };
}

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.MAIL_USER, 
        pass: process.env.MAIL_PASS 
    }
});

app.get('/addresses', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/');
    }

    try {
        const userId = req.session.user.id;
        const result = await sqlQuery(
            'SELECT * FROM user_addresses WHERE user_id = $1 ORDER BY id DESC', 
            [userId]
        );
        
        res.render('addresses', {
            title: 'Мои адреса',
            addresses: result.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/addresses/add', async (req, res) => {
    if (!req.session.user) return res.redirect('/');

    const { city, street, house, apartment, entrance, floor, intercom, comment } = req.body;
    const userId = req.session.user.id;

    try {
        await sqlQuery(
            `INSERT INTO user_addresses 
            (user_id, city, street, house, apartment, entrance, floor, intercom, comment) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                userId,
                city,
                street,
                house,
                apartment,
                entrance,
                floor,
                intercom,
                comment
            ]
        );
        
        res.redirect('/addresses');
    } catch (err) {
        console.error('Ошибка добавления адреса:', err);
        res.redirect('/addresses?error=save_failed');
    }
});

app.post('/addresses/update', async (req, res) => {
    if (!req.session.user) return res.redirect('/');

    const { id, city, street, house, apartment, entrance, floor, intercom, comment } = req.body;
    const userId = req.session.user.id;

    try {
        await sqlQuery(
            `UPDATE user_addresses 
             SET city = $1, street = $2, house = $3, apartment = $4, 
                 entrance = $5, floor = $6, intercom = $7, comment = $8
             WHERE id = $9 AND user_id = $10`,
            [city, street, house, apartment, entrance, floor, intercom, comment, id, userId]
        );
        
        res.redirect('/addresses');
    } catch (err) {
        console.error('Ошибка обновления адреса:', err);
        res.redirect('/addresses?error=update_failed');
    }
});

app.post('/addresses/delete', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    
    const { id } = req.body;
    const userId = req.session.user.id;

    try {
        // Удаляем, ТОЛЬКО если этот адрес принадлежит текущему юзеру (безопасность!)
        await sqlQuery('DELETE FROM user_addresses WHERE id = $1 AND user_id = $2', [id, userId]);
        res.redirect('/addresses');
    } catch (err) {
        console.error(err);
        res.redirect('/addresses');
    }
});

app.get('/cart', async (req, res) => {
    if (!req.session.cart) req.session.cart = [];
    
    const cart = req.session.cart;
    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const promo = req.session.promo || null;

    let userAddresses = [];
    if (req.session.user) {
        const addrResult = await sqlQuery('SELECT * FROM user_addresses WHERE user_id = $1 ORDER BY id DESC', [req.session.user.id]);
        userAddresses = addrResult.rows;
    }

    res.render('cart', {
        title: 'Оформление заказа',
        cart: cart,
        subtotal: subtotal,
        promo: promo,
        userAddresses: userAddresses,
        // Передаем константы для JS
        FREE_DELIVERY_THRESHOLD,
        DELIVERY_COST,
        PICKUP_DISCOUNT_PERCENT
    });
});

app.post('/cart/clear', (req, res) => {
    req.session.cart = [];
    req.session.promo = null;
    res.json({ success: true });
});

app.post('/cart/promo', async (req, res) => {
    const { code } = req.body;
    
    if (!code) {
        req.session.promo = null;
        return res.json({ success: true, message: 'Промокод удален' });
    }

    try {
        const query = `
            SELECT * FROM promocodes 
            WHERE code = $1 
            AND is_active = TRUE
            AND (valid_from IS NULL OR valid_from <= NOW()) -- Проверка, что промокод уже начал действовать
            AND (valid_to IS NULL OR valid_to >= NOW())     -- Проверка, что промокод еще не закончился
        `;
        const result = await sqlQuery(query, [code.toUpperCase()]);
        
        if (result.rows.length > 0) {
            const promo = result.rows[0];
            
            req.session.promo = {
                code: promo.code,
                discount: promo.discount_percent
            };
            
            res.json({ success: true, discount: promo.discount_percent });
        } else {
            res.json({ success: false, message: 'Промокод не найден' });
        }
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/orders/create', async (req, res) => {
    if (!req.session.user) return res.json({ success: false, message: 'Нужна авторизация' });
    if (!req.session.cart || !req.session.cart.length) return res.json({ success: false, message: 'Корзина пуста' });

    console.log('=== ДАННЫЕ ОТ БРАУЗЕРА ===', req.body);

    // ДОБАВИЛ: change_from из req.body
    const { contact_name, contact_phone, delivery_type, address_id, payment_method, change_from } = req.body;
    const userId = req.session.user.id;
    const cart = req.session.cart;
    
    // ДОБАВИЛ: Логика обработки сдачи. Записываем только если это наличные и поле не пустое
    const changeFromValue = (payment_method === 'cash' && change_from) ? parseInt(change_from) : null;

    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    // --- Пересчет скидок на сервере ---
    let promoDiscountAmount = 0;
    if (req.session.promo) {
        promoDiscountAmount = Math.floor((subtotal * req.session.promo.discount) / 100);
    }
    const pickupDiscountAmount = Math.floor((subtotal * PICKUP_DISCOUNT_PERCENT) / 100);

    let finalDiscountAmount = 0;
    if (delivery_type === 'pickup' && pickupDiscountAmount >= promoDiscountAmount) {
        finalDiscountAmount = pickupDiscountAmount;
    } else {
        finalDiscountAmount = promoDiscountAmount;
    }

    const priceAfterDiscount = subtotal - finalDiscountAmount;

    // --- Пересчет доставки на сервере ---
    let deliveryCost = 0;
    if (delivery_type === 'delivery' && subtotal < FREE_DELIVERY_THRESHOLD) {
        deliveryCost = DELIVERY_COST;
    }

    const finalPrice = priceAfterDiscount + deliveryCost;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // ДОБАВИЛ: change_from в SQL-запрос
        const orderRes = await client.query(
            `INSERT INTO orders (user_id, total_price, type, contact_name, contact_phone, address_id, payment_method, subtotal_price, discount_amount, delivery_cost, change_from) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [userId, finalPrice, delivery_type, contact_name, contact_phone, (delivery_type === 'delivery' ? address_id : null), payment_method, subtotal, finalDiscountAmount, deliveryCost, changeFromValue]
        );
        const orderId = orderRes.rows[0].id;

        for (const item of cart) {
            await client.query(
                `INSERT INTO order_items (order_id, product_id, quantity, price_at_moment) VALUES ($1, $2, $3, $4)`,
                [orderId, item.id, item.quantity, item.price]
            );
        }

        await client.query('COMMIT');
        
        req.session.cart = [];
        req.session.promo = null;

        io.emit('new_order');
        
        res.json({ success: true, orderId: orderId });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Ошибка создания заказа:', err);
        res.json({ success: false, message: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/cart/add', async (req, res) => {

    if (!req.session.user) {
        return res.json({ success: false, message: 'Необходима авторизация' });
    }

    const { productId } = req.body;

    try {
        const result = await sqlQuery('SELECT * FROM products WHERE id = $1', [productId]);
        
        if (result.rows.length === 0) {
            return res.json({ success: false, message: 'Товар не найден' });
        }
        const product = result.rows[0];

        if (!req.session.cart) req.session.cart = [];

        const existingItemIndex = req.session.cart.findIndex(item => item.id === product.id);

        if (existingItemIndex > -1) {
            req.session.cart[existingItemIndex].quantity += 1;
        } else {
            req.session.cart.push({
                id: product.id,
                name: product.name,
                price: parseFloat(product.price),
                image_url: product.image_url,
                quantity: 1
            });
        }

        const totalCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);

        res.json({ success: true, totalCount });

    } catch (err) {
        console.error(err);
        res.json({ success: false, message: 'Ошибка сервера' });
    }
});

app.post('/cart/update', (req, res) => {
    const { productId, action } = req.body; 
    
    if (!req.session.cart) return res.json({ success: false });

    const cart = req.session.cart;
    const itemIndex = cart.findIndex(item => item.id == productId);

    if (itemIndex > -1) {
        if (action === 'increase') {
            cart[itemIndex].quantity++;
        } else if (action === 'decrease') {
            cart[itemIndex].quantity--;
            if (cart[itemIndex].quantity <= 0) {
                cart.splice(itemIndex, 1);
            }
        } else if (action === 'remove') {
            cart.splice(itemIndex, 1);
        }
    }

    req.session.cart = cart;
    
    // --- Полный пересчет ---
    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    let promoDiscountAmount = 0;
    if (req.session.promo) {
        promoDiscountAmount = Math.floor((subtotal * req.session.promo.discount) / 100);
    }
    const pickupDiscountAmount = Math.floor((subtotal * PICKUP_DISCOUNT_PERCENT) / 100);

    let finalDiscountAmount = Math.max(promoDiscountAmount, 0); // По умолчанию - скидка по промокоду
    
    const priceAfterDiscount = subtotal - finalDiscountAmount;
    
    let deliveryCost = 0;
    if (subtotal < FREE_DELIVERY_THRESHOLD) {
        deliveryCost = DELIVERY_COST;
    }
    
    const finalPrice = priceAfterDiscount + deliveryCost;
    const totalCount = cart.reduce((sum, item) => sum + item.quantity, 0);

    res.json({
        success: true,
        cart: cart,
        totalCount: totalCount,
        subtotal: subtotal,
        promoDiscountAmount: promoDiscountAmount,
        pickupDiscountAmount: pickupDiscountAmount,
        deliveryCost: deliveryCost,
        totalPrice: finalPrice,
        priceAfterDiscount: priceAfterDiscount
    });
});

app.post('/register', async (req, res) => {
    const { name, phone, email, password } = req.body;

    try {
        if (!name || !phone || !email || !password) {
            return res.json({ success: false, message: 'Заполните все поля' });
        }

        const userCheck = await sqlQuery('SELECT * FROM users WHERE email = $1', [email]);
        if (userCheck.rows.length > 0) {
            return res.json({ success: false, message: 'Такой email уже зарегистрирован' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const token = crypto.randomBytes(32).toString('hex');

        await sqlQuery(
            'INSERT INTO users (name, phone, email, password_hash, verification_token) VALUES ($1, $2, $3, $4, $5)',
            [name, phone, email, hashedPassword, token]
        );

        const verificationLink = `http://localhost:3000/verify-email?token=${token}`;

        await transporter.sendMail({
            from: '"Якитория" <tvoj_email@gmail.com>',
            to: email,
            subject: 'Подтверждение регистрации',
            html: `
                <h1>Добро пожаловать, ${name}!</h1>
                <p>Пожалуйста, подтвердите вашу почту, нажав на ссылку ниже:</p>
                <a href="${verificationLink}">Подтвердить Email</a>
            `
        });

        res.json({ success: true, message: 'check_email' });

    } catch (err) {
        console.error('Ошибка регистрации:', err);
        res.json({ success: false, message: 'Ошибка сервера' });
    }
});

app.get('/verify-email', async (req, res) => {
    const { token } = req.query;

    if (!token) return res.redirect('/');

    try {
        const result = await sqlQuery('SELECT * FROM users WHERE verification_token = $1', [token]);

        if (result.rows.length > 0) {
            const user = result.rows[0];

            await sqlQuery('UPDATE users SET is_verified = TRUE, verification_token = NULL WHERE id = $1', [user.id]);

            req.session.user = { id: user.id, name: user.name, email: user.email };
            
            res.redirect('/?verified=true');
        } else {
            res.send('<h1>Ошибка подтверждения</h1><p>Неверный или устаревший токен.</p>');
        }
    } catch (err) {
        console.error(err);
        res.send('Ошибка сервера');
    }
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const result = await sqlQuery('SELECT * FROM users WHERE email = $1', [email]);
        
        if (result.rows.length > 0) {
            const user = result.rows[0];

            if (!user.is_verified) {
                return res.json({ success: false, message: 'Пожалуйста, подтвердите вашу почту перед входом.' });
            }

            const match = await bcrypt.compare(password, user.password_hash);
            if (match) {
                req.session.user = { id: user.id, name: user.name, email: user.email };
                return res.json({ success: true });
            }
        }
        res.json({ success: false, message: 'Неверный email или пароль' });

    } catch (err) {
        console.error(err);
        res.json({ success: false, message: 'Ошибка сервера' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        const backURL = req.header('Referer') || '/';
        res.redirect(backURL);
    });
});

app.get('/', async (req, res) => {
  try {
    const query = `
      SELECT
          c.name AS category_name,
          c.slug AS category_slug,
          c.order_num AS category_order,
          p.id,
          p.name,
          p.subtitle,
          p.description,
          p.price,
          p.image_url,
          p.special_tag
      FROM products p
      JOIN categories c ON p.category_id = c.id
      WHERE p.is_available = TRUE
      ORDER BY c.order_num, p.id;
    `;
    const result = await sqlQuery(query);

    const groupedProducts = {};
    result.rows.forEach(row => {
      if (!groupedProducts[row.category_slug]) {
        groupedProducts[row.category_slug] = {
          name: row.category_name,
          slug: row.category_slug,
          order_num: row.category_order,
          products: []
        };
      }
      groupedProducts[row.category_slug].products.push({
        id: row.id,
        name: row.name,
        subtitle: row.subtitle,
        description: row.description,
        price: parseFloat(row.price),
        image_url: row.image_url,
        special_tag: row.special_tag
      });
    });

    const categoriesArray = Object.values(groupedProducts).sort((a, b) => a.order_num - b.order_num);

    res.render('index', {
      title: 'Якитория - Заказ роллов', 
      categories: categoriesArray,
    });

  } catch (err) {
    console.error('Ошибка при загрузке главной страницы:', err);
    res.status(500).send('Внутренняя ошибка сервера при загрузке ассортимента.');
  }
});

app.get('/category/:slug', async (req, res) => {
  try {
    const categorySlug = req.params.slug;

    const categoryInfoResult = await sqlQuery('SELECT id, name, slug FROM categories WHERE slug = $1', [categorySlug]);
    if (categoryInfoResult.rows.length === 0) {
      return res.status(404).send('Категория не найдена');
    }
    const categoryInfo = categoryInfoResult.rows[0];

    const productsResult = await sqlQuery(
      `SELECT
          p.id,
          p.name,
          p.subtitle,
          p.description,
          p.price,
          p.image_url,
          p.special_tag
      FROM products p
      WHERE p.category_id = $1 AND p.is_available = TRUE
      ORDER BY p.id;`,
      [categoryInfo.id]
    );

    res.render('category', { 
      title: `${categoryInfo.name} - Якитория`,
      category: categoryInfo,
      products: productsResult.rows,
    });

  } catch (err) {
    console.error('Ошибка при загрузке страницы категории:', err);
    res.status(500).send('Внутренняя ошибка сервера при загрузке категории.');
  }
});

app.get('/staff/login', (req, res) => {
    res.render('staff/login', { layout: false, error: null });
});

app.post('/staff/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await sqlQuery('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            const match = await bcrypt.compare(password, user.password_hash);
            
            if (match) {
                if (user.role === 'customer') {
                    return res.render('staff/login', { layout: false, error: 'Доступ запрещен. У вас роль Клиент.' });
                }

                req.session.user = user;
                
                if (user.role === 'admin') {
                    return res.redirect('/admin');
                }
                if (user.role === 'cook') {
                    return res.redirect('/kitchen');
                }
                if (user.role === 'cashier') return res.redirect('/pos');
                if (user.role === 'courier') return res.redirect('/courier'); 
                
                return res.redirect('/'); 
            }
        }
        res.render('staff/login', { layout: false, error: 'Неверные данные' });
    } catch (err) {
        console.error(err);
        res.render('staff/login', { layout: false, error: 'Ошибка сервера' });
    }
});

app.get('/kitchen', checkRole(['cook', 'admin']), (req, res) => {
    res.redirect('/kitchen/sushi');
});

app.get('/courier', checkRole(['courier', 'admin']), async (req, res) => {
    try {
        const courierId = req.session.user.id;

        const query = `
            SELECT 
                o.id, 
                o.total_price, 
                o.payment_method, 
                o.change_from,
                o.contact_name, 
                o.contact_phone,
                o.created_at,
                o.delivery_address_details, -- Добавили колонку с JSON адресом
                ua.city, 
                ua.street, 
                ua.house, 
                ua.apartment, 
                ua.entrance, 
                ua.floor, 
                ua.intercom, 
                ua.comment
            FROM orders o
            LEFT JOIN user_addresses ua ON o.address_id = ua.id
            WHERE o.status = 'delivering' AND o.courier_id = $1
            ORDER BY o.created_at ASC
        `;

        const result = await sqlQuery(query, [courierId]);
        let orders = result.rows;

        // ПРЕОБРАЗОВАНИЕ АДРЕСА:
        // Если заказ создан кассиром, адрес лежит в delivery_address_details
        orders.forEach(order => {
            if (order.delivery_address_details) {
                try {
                    const details = typeof order.delivery_address_details === 'string' 
                        ? JSON.parse(order.delivery_address_details) 
                        : order.delivery_address_details;
                    
                    // Теперь берем город и дом из JSON-объекта
                    order.city = details.city || ''; 
                    order.street = details.street || '';
                    order.house = details.house || ''; 
                    order.apartment = details.apartment || '';
                    order.entrance = details.entrance || '';
                    order.floor = details.floor || '';
                    order.intercom = details.intercom || '';
                } catch (e) {
                    console.error('Ошибка парсинга адреса для заказа', order.id);
                }
            }
        });

        res.render('staff/courier', {
            orders: orders,
            user: req.session.user,
        });
    } catch (err) {
        console.error('Ошибка курьера:', err);
        res.status(500).send('Ошибка загрузки заказов');
    }
});

app.post('/courier/complete', checkRole(['courier', 'admin']), async (req, res) => {
    const { orderId } = req.body;
    try {
        await sqlQuery("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false });
    }
});

app.get('/courier/account', checkRole(['courier', 'admin']), async (req, res) => {
    try {
        const courierId = req.session.user.id;

        // --- ЗАПРОС ЛИЧНОЙ ИНФОРМАЦИИ ---
        // Получаем всю нужную информацию о курьере в одном запросе
        const userResult = await sqlQuery(
            'SELECT name, email, phone, role, is_on_shift, avatar_url FROM users WHERE id = $1', 
            [courierId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).send('Пользователь не найден');
        }
        const courierInfo = userResult.rows[0];

        // --- ЗАПРОС СТАТИСТИКИ ПО ЗАКАЗАМ (как и было) ---
        const dateFilter = req.query.date || new Date().toISOString().split('T')[0];
        
        const ordersQuery = `
            SELECT o.id, o.total_price, o.updated_at, ua.street, ua.house
            FROM orders o
            LEFT JOIN user_addresses ua ON o.address_id = ua.id
            WHERE o.courier_id = $1 AND o.status = 'completed' AND DATE(o.updated_at) = $2 
            ORDER BY o.updated_at DESC
        `;
        const ordersResult = await sqlQuery(ordersQuery, [courierId, dateFilter]);
        const completedOrders = ordersResult.rows;

        const totalEarned = completedOrders.reduce((sum, order) => sum + parseFloat(order.total_price), 0);

        // --- РЕНДЕР СТРАНИЦЫ ---
        // Передаем в шаблон всю информацию
        res.render('staff/courier_account', {
            user: req.session.user, // Для общих нужд
            courierInfo: courierInfo, // Вся личная информация
            orders: completedOrders,
            orderCount: completedOrders.length,
            totalEarned: totalEarned,
            currentDate: dateFilter,
            isOnShift: courierInfo.is_on_shift // Берем статус отсюда для удобства
        });

    } catch (err) {
        console.error("Ошибка в личном кабинете курьера:", err);
        res.status(500).send('Ошибка загрузки данных');
    }
});

app.post('/courier/shift', checkRole(['courier', 'admin']), async (req, res) => {
    const courierId = req.session.user.id;
    const { newStatus } = req.body; // Ожидаем 'online' или 'offline'

    try {
        // ЗАЩИТА: Нельзя закрыть смену, если есть активные заказы
        if (newStatus === 'offline') {
            const activeOrdersResult = await sqlQuery(
                `SELECT COUNT(id) FROM orders WHERE courier_id = $1 AND status = 'delivering'`,
                [courierId]
            );
            const activeOrdersCount = parseInt(activeOrdersResult.rows[0].count);

            if (activeOrdersCount > 0) {
                return res.status(409).json({ 
                    success: false, 
                    message: `Нельзя закрыть смену, у вас ${activeOrdersCount} незавершенных заказов!` 
                });
            }
        }

        // Обновляем статус в базе данных
        const isOnShift = (newStatus === 'online');
        await sqlQuery(
            'UPDATE users SET is_on_shift = $1 WHERE id = $2',
            [isOnShift, courierId]
        );

        res.json({ success: true, message: `Смена ${isOnShift ? 'открыта' : 'закрыта'}.` });

    } catch (err) {
        console.error("Ошибка при изменении статуса смены:", err);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.get('/api/couriers', checkRole(['cashier', 'admin']), async (req, res) => {
    try {
        const result = await sqlQuery(
            "SELECT id, name FROM users WHERE role = 'courier' AND is_on_shift = TRUE"
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Ошибка получения списка курьеров:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/courier/order-items/:id', checkRole(['courier', 'admin']), async (req, res) => {
    try {
        const orderId = req.params.id;
        
        const query = `
            SELECT 
                oi.quantity, 
                oi.price_at_moment AS price, 
                p.name 
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = $1
        `;
        
        const result = await sqlQuery(query, [orderId]);
        
        res.json({ items: result.rows });
    } catch (err) {
        console.error('Ошибка получения состава заказа курьером:', err);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/kitchen/:deptSlug', checkRole(['cook', 'admin']), async (req, res) => {
    const deptSlug = req.params.deptSlug;

    try {
        const deptsRes = await sqlQuery('SELECT * FROM departments');
        const currentDept = deptsRes.rows.find(d => d.slug === deptSlug);
        
        if (!currentDept) return res.status(404).send('Цех не найден');

        const query = `
            SELECT 
                o.id as order_id, 
                o.created_at,
                o.contact_name,
                oi.id as item_id,
                oi.quantity,
                oi.item_status,
                p.name as product_name
            FROM orders o
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE p.department_id = $1  -- Только товары этого цеха
            AND o.status NOT IN ('completed', 'cancelled') -- Заказ в работе
            AND oi.item_status != 'done' -- Блюдо еще не отдано
            ORDER BY o.created_at ASC;
        `;

        const result = await sqlQuery(query, [currentDept.id]);

        const ordersMap = {};
        result.rows.forEach(row => {
            if (!ordersMap[row.order_id]) {
                ordersMap[row.order_id] = {
                    id: row.order_id,
                    created_at: row.created_at,
                    waiter: row.contact_name || 'Гость',
                    items: []
                };
            }
            ordersMap[row.order_id].items.push({
                id: row.item_id,
                name: row.product_name,
                quantity: row.quantity,
                status: row.item_status
            });
        });

        res.render('staff/kitchen', {
            departments: deptsRes.rows,
            currentDept: currentDept,
            orders: Object.values(ordersMap),
            layout: false // Используем свой HTML внутри kitchen.ejs
        });

    } catch (err) {
        console.error(err);
        res.send('Ошибка кухни');
    }
});

app.get('/orders', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/');
    }

    try {
        const userId = req.session.user.id;

        const result = await sqlQuery(
            `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC`, 
            [userId]
        );

        const allOrders = result.rows;

        const activeStatuses = ['new', 'cooking', 'ready', 'delivering'];
        
        const activeOrders = allOrders.filter(o => activeStatuses.includes(o.status));
        const historyOrders = allOrders.filter(o => !activeStatuses.includes(o.status));

        res.render('orders', {
            title: 'Мои заказы - Якитория',
            activeOrders,
            historyOrders,
            user: req.session.user
        });
    } catch (err) {
        console.error('Ошибка загрузки заказов:', err);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/orders/review', async (req, res) => {
    if (!req.session.user) return res.json({ success: false, message: 'Не авторизован' });

    const { orderId, rating, reviewText } = req.body;
    const userId = req.session.user.id;

    try {
        const result = await sqlQuery(
            `UPDATE orders 
             SET rating = $1, review_text = $2 
             WHERE id = $3 AND user_id = $4 AND status = 'completed'`,
            [rating, reviewText, orderId, userId]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Ошибка сохранения отзыва:', err);
        res.json({ success: false });
    }
});

async function syncOrderStatus(orderId) {
    const result = await sqlQuery('SELECT item_status FROM order_items WHERE order_id = $1', [orderId]);
    const items = result.rows;

    if (items.length === 0) return;

    const allDone = items.every(item => item.item_status === 'done');
    const anyInWork = items.some(item => item.item_status === 'cooking' || item.item_status === 'done');

    let newStatus = 'new';

    if (allDone) {
        newStatus = 'ready'; 
    } else if (anyInWork) {
        newStatus = 'cooking';
    }

    await sqlQuery('UPDATE orders SET status = $1 WHERE id = $2', [newStatus, orderId]);

    if (newStatus === 'ready') {
        io.emit('order_ready', { orderId: orderId });
    }
}

app.get('/pos/order-details/:id', checkRole(['cashier', 'admin']), async (req, res) => {
    try {
        const orderId = req.params.id;

        const query = `
            SELECT 
                oi.quantity, 
                oi.price_at_moment, 
                p.name 
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            WHERE oi.order_id = $1
            ORDER BY p.name
        `;
        
        const result = await sqlQuery(query, [orderId]);
        
        if (result.rows.length === 0) {
            return res.json({ success: true, items: [] }); // Возвращаем пустой массив, если заказ пуст
        }

        res.json({ success: true, items: result.rows });

    } catch (err) {
        console.error('Ошибка получения деталей заказа для POS:', err);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

app.get('/api/active-promocodes', checkRole(['cashier', 'admin']), async (req, res) => {
    try {
        const query = `
            SELECT code, discount_percent FROM promocodes 
            WHERE is_active = TRUE
              AND (valid_from IS NULL OR valid_from <= NOW())
              AND (valid_to IS NULL OR valid_to >= NOW())
        `;
        const result = await sqlQuery(query);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json([]);
    }
});

app.get('/pos', checkRole(['cashier', 'admin']), async (req, res) => {
    try {
        const ordersRes = await sqlQuery(`
            SELECT * FROM orders 
            WHERE status = 'ready' 
            ORDER BY created_at ASC
        `);

        const promoRes = await sqlQuery(`
            SELECT code, discount_percent FROM promocodes 
            WHERE is_active = TRUE AND (valid_from IS NULL OR valid_from <= NOW()) AND (valid_to IS NULL OR valid_to >= NOW())
        `);

        const catsRes = await sqlQuery('SELECT * FROM categories ORDER BY order_num');
        const prodsRes = await sqlQuery('SELECT * FROM products WHERE is_available = TRUE ORDER BY id');

        res.render('staff/pos', { 
            orders: ordersRes.rows,
            categories: catsRes.rows,
            products: prodsRes.rows,
            promocodes: promoRes.rows
        });
    } catch (err) { console.error(err); res.send('Ошибка POS'); }
});

app.post('/pos/status', checkRole(['cashier', 'admin']), async (req, res) => {
    const { orderId, type, courierId } = req.body; // Добавили courierId
    
    try {
        let newStatus = 'completed';
        
        if (type === 'delivery') {
            newStatus = 'delivering';
            // Если это доставка, обновляем статус И назначаем курьера
            if (!courierId) {
                return res.status(400).json({ success: false, message: 'Не выбран курьер' });
            }
            await sqlQuery(
                "UPDATE orders SET status = $1, courier_id = $2 WHERE id = $3", 
                [newStatus, courierId, orderId]
            );

            io.emit('courier_assigned', { courierId: Number(courierId), orderId: orderId });

        } else { // Для самовывоза логика не меняется
            await sqlQuery(
                "UPDATE orders SET status = $1 WHERE id = $2", 
                [newStatus, orderId]
            );
        }
        res.json({ success: true });

    } catch (err) {
        console.error('Ошибка обновления статуса заказа:', err);
        res.status(500).json({ success: false });
    }
});

app.post('/pos/create-order', checkRole(['cashier', 'admin']), async (req, res) => {
    // Теперь мы получаем гораздо больше данных
    const { items, type, payment, changeFrom, clientInfo, addressInfo, discount } = req.body; 

    if (!items || items.length === 0) {
        return res.status(400).json({ success: false, message: 'Корзина пуста' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // --- 1. СЕРВЕРНЫЙ ПЕРЕСЧЕТ СТОИМОСТИ (НИКОГДА НЕ ДОВЕРЯТЬ КЛИЕНТУ) ---
        const subtotal = items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
        let discountPercent = 0;

        // Определяем процент скидки
        if (discount.type === 'birthday') {
            discountPercent = 10;
        } else if (discount.type === 'student' || discount.type === 'pensioner') {
            discountPercent = 5;
        } else if (discount.type === 'promocode' && discount.code) {
            const promoRes = await client.query('SELECT discount_percent FROM promocodes WHERE code = $1 AND is_active = TRUE', [discount.code]);
            if (promoRes.rows.length > 0) {
                discountPercent = promoRes.rows[0].discount_percent;
            }
        }
        
        const discountAmount = Math.floor(subtotal * (discountPercent / 100));
        const priceAfterDiscount = subtotal - discountAmount;
        
        // --- 2. РАСЧЕТ ДОСТАВКИ ---
        let deliveryCost = 0;
        if (type === 'delivery' && subtotal < 699) { // Используем константу, если она есть
            deliveryCost = 150;
        }
        
        const finalPrice = priceAfterDiscount + deliveryCost;

        // --- 3. СОЗДАНИЕ ЗАКАЗА В БАЗЕ ---
        const ordRes = await client.query(
            `INSERT INTO orders (total_price, type, payment_method, status, contact_name, contact_phone, delivery_address_details, subtotal_price, discount_amount, delivery_cost, change_from) 
             VALUES ($1, $2, $3, 'new', $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
            [
                finalPrice, 
                type, 
                payment, // Теперь сюда попадет 'cash' или 'card'
                clientInfo.name || 'Гость в зале', 
                clientInfo.phone || null,
                type === 'delivery' ? JSON.stringify(addressInfo) : null,
                subtotal,
                discountAmount,
                deliveryCost,
                changeFrom // Сохраняем сдачу
            ]
        );
        const orderId = ordRes.rows[0].id;

        for (const item of items) {
            await client.query(
                `INSERT INTO order_items (order_id, product_id, quantity, price_at_moment) VALUES ($1, $2, $3, $4)`,
                [orderId, item.id, item.quantity, item.price]
            );
        }

        await client.query('COMMIT');
        io.emit('new_order');
        res.json({ success: true, orderId: orderId });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Ошибка создания заказа через POS:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    } finally {
        client.release();
    }
});

app.post('/kitchen/item/status', checkRole(['cook', 'admin']), async (req, res) => {
    const { itemId, status } = req.body;
    try {
        await sqlQuery('UPDATE order_items SET item_status = $1 WHERE id = $2', [status, itemId]);
        
        const itemRes = await sqlQuery('SELECT order_id FROM order_items WHERE id = $1', [itemId]);
        if (itemRes.rows.length > 0) {
            const orderId = itemRes.rows[0].order_id;
            await syncOrderStatus(orderId);
        }

        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ success: false }); 
    }
});

app.post('/kitchen/order/done', checkRole(['cook', 'admin']), async (req, res) => {
    const { orderId, deptId } = req.body;
    try {
        await sqlQuery(`
            UPDATE order_items 
            SET item_status = 'done' 
            FROM products 
            WHERE order_items.product_id = products.id 
            AND order_items.order_id = $1 
            AND products.department_id = $2`, 
            [orderId, deptId]
        );

        await syncOrderStatus(orderId);

        res.json({ success: true });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ success: false }); 
    }
});

const adminRouter = express.Router();

adminRouter.use(checkRole(['admin']));

app.use('/admin', adminRouter);

adminRouter.get('/', async (req, res) => {
    try {
        const todayRes = await sqlQuery(`
            SELECT 
                COALESCE(SUM(total_price), 0) as revenue,
                COUNT(id) as orders_count
            FROM orders 
            WHERE status = 'completed' AND created_at >= CURRENT_DATE
        `);
        const todayRevenue = parseFloat(todayRes.rows[0].revenue);
        const todayOrders = parseInt(todayRes.rows[0].orders_count);

        const yesterdayRes = await sqlQuery(`
            SELECT 
                COALESCE(SUM(total_price), 0) as revenue,
                COUNT(id) as orders_count
            FROM orders 
            WHERE status = 'completed' 
            AND created_at >= CURRENT_DATE - INTERVAL '1 day' 
            AND created_at < CURRENT_DATE
        `);
        const yesterdayRevenue = parseFloat(yesterdayRes.rows[0].revenue);
        const yesterdayOrders = parseInt(yesterdayRes.rows[0].orders_count);

        const revenueTrend = yesterdayRevenue === 0 ? 100 : Math.round(((todayRevenue - yesterdayRevenue) / yesterdayRevenue) * 100);
        
        const avgCheck = todayOrders === 0 ? 0 : Math.round(todayRevenue / todayOrders);

        const activeRes = await sqlQuery("SELECT COUNT(id) as count FROM orders WHERE status NOT IN ('completed', 'cancelled')");
        const activeOrders = activeRes.rows[0].count;

        const chartRes = await sqlQuery(`
            SELECT 
                TO_CHAR(DATE(created_at), 'DD.MM') as date,
                SUM(total_price) as total
            FROM orders
            WHERE status = 'completed' AND created_at >= CURRENT_DATE - INTERVAL '6 days'
            GROUP BY DATE(created_at)
            ORDER BY DATE(created_at) ASC
        `);
        
        const chartLabels = chartRes.rows.map(row => row.date);
        const chartData = chartRes.rows.map(row => parseFloat(row.total));

        const topProductsRes = await sqlQuery(`
            SELECT p.name, SUM(oi.quantity) as total_sold
            FROM order_items oi
            JOIN products p ON oi.product_id = p.id
            GROUP BY p.id, p.name
            ORDER BY total_sold DESC
            LIMIT 5
        `);

        const recentOrdersRes = await sqlQuery(`
            SELECT id, total_price, status, created_at, contact_name 
            FROM orders 
            ORDER BY created_at DESC 
            LIMIT 5
        `);

        res.render('admin/dashboard', {
            title: 'Аналитика',
            stats: {
                todayRevenue,
                revenueTrend,
                todayOrders,
                avgCheck,
                activeOrders
            },
            chartData: {
                labels: chartLabels,
                data: chartData
            },
            topProducts: topProductsRes.rows,
            recentOrders: recentOrdersRes.rows
        });

    } catch (error) {
        console.error("Ошибка при загрузке дашборда:", error);
        res.status(500).send("Ошибка сервера");
    }
});

adminRouter.get('/products', async (req, res) => {
    try {
        const result = await sqlQuery(`
            SELECT p.*, c.name as category_name 
            FROM products p 
            LEFT JOIN categories c ON p.category_id = c.id
            ORDER BY p.id DESC
        `);

        res.render('admin/products', { 
            title: 'Управление товарами',
            products: result.rows
        });
    } catch (error) {
        console.error("Ошибка загрузки товаров:", error);
        res.status(500).send("Ошибка сервера");
    }
});

const adminApiRouter = express.Router();
adminApiRouter.use(checkRole(['admin']));
app.use('/admin/api', adminApiRouter);

adminApiRouter.get('/products/form', async (req, res) => {
    try {
        const categoriesResult = await sqlQuery('SELECT * FROM categories ORDER BY name');
        
        res.render('admin/partials/product_form_content', {
            product: {},
            categories: categoriesResult.rows,
            action: '/admin/api/products/new',
            buttonText: 'Создать товар'
        });
    } catch (error) {
        console.error("Ошибка при запросе пустой формы товара:", error);
        res.status(500).send('Ошибка сервера');
    }
});

adminApiRouter.get('/products/form/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const productResult = await sqlQuery('SELECT * FROM products WHERE id = $1', [id]);
        if (productResult.rows.length === 0) {
            return res.status(404).send('Товар не найден');
        }
        
        const categoriesResult = await sqlQuery('SELECT * FROM categories ORDER BY name');
        
        res.render('admin/partials/product_form_content', {
            product: productResult.rows[0],
            categories: categoriesResult.rows,
            action: `/admin/api/products/edit/${id}`,
            buttonText: 'Сохранить изменения'
        });
    } catch (error) {
        console.error("Ошибка при запросе формы редактирования товара:", error);
        res.status(500).send('Ошибка сервера');
    }
});

adminApiRouter.post('/products/new', upload.single('image'), async (req, res) => {
    const { name, subtitle, description, price, category_id } = req.body;
    const is_available = req.body.is_available === 'on';
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    try {
        await sqlQuery(
            `INSERT INTO products (name, subtitle, description, price, category_id, is_available, image_url) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [name, subtitle, description, price, category_id, is_available, imageUrl]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

adminApiRouter.post('/products/edit/:id', upload.single('image'), async (req, res) => {
    const { id } = req.params;
    const { name, subtitle, description, price, category_id } = req.body;
    const is_available = req.body.is_available === 'on';

    try {
        if (req.file) {
            const imageUrl = `/uploads/${req.file.filename}`;
            await sqlQuery(
                `UPDATE products SET name=$1, subtitle=$2, description=$3, price=$4, category_id=$5, is_available=$6, image_url=$7 WHERE id=$8`,
                [name, subtitle, description, price, category_id, is_available, imageUrl, id]
            );
        } else {
            await sqlQuery(
                `UPDATE products SET name=$1, subtitle=$2, description=$3, price=$4, category_id=$5, is_available=$6 WHERE id=$7`,
                [name, subtitle, description, price, category_id, is_available, id]
            );
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

adminRouter.post('/products/delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await sqlQuery('DELETE FROM products WHERE id = $1', [id]);
        res.redirect('/admin/products');
    } catch (error) {
        console.error("Ошибка при удалении товара:", error);
        res.status(500).send("Не удалось удалить товар. Возможно, он уже используется в заказах. Вместо удаления деактивируйте его.");
    }
});

adminRouter.get('/categories', async (req, res) => {
    try {
        const result = await sqlQuery('SELECT * FROM categories ORDER BY order_num, name');
        res.render('admin/categories', {
            title: 'Управление категориями',
            categories: result.rows
        });
    } catch (error) {
        console.error("Ошибка загрузки категорий:", error);
        res.status(500).send("Ошибка сервера");
    }
});

adminApiRouter.get('/categories/form', (req, res) => {
    res.render('admin/partials/category_form_content', {
        title: 'Новая категория',
        category: {},
        action: '/admin/api/categories/new',
        buttonText: 'Создать'
    });
});

adminApiRouter.get('/categories/form/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await sqlQuery('SELECT * FROM categories WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).send('Категория не найдена');
        }
        res.render('admin/partials/category_form_content', {
            title: 'Редактировать категорию',
            category: result.rows[0],
            action: `/admin/api/categories/edit/${id}`,
            buttonText: 'Сохранить'
        });
    } catch (error) {
        res.status(500).send('Ошибка сервера');
    }
});

adminApiRouter.post('/categories/new', async (req, res) => {
    const { name, slug, order_num } = req.body;
    try {
        await sqlQuery('INSERT INTO categories (name, slug, order_num) VALUES ($1, $2, $3)', [name, slug, order_num]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

adminApiRouter.post('/categories/edit/:id', async (req, res) => {
    const { id } = req.params;
    const { name, slug, order_num } = req.body;
    try {
        await sqlQuery('UPDATE categories SET name = $1, slug = $2, order_num = $3 WHERE id = $4', [name, slug, order_num, id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

adminApiRouter.post('/categories/delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await sqlQuery('DELETE FROM categories WHERE id = $1', [id]);
        res.redirect('/admin/categories'); 
    } catch (error) {
        res.status(500).send('Ошибка при удалении. Возможно, в категории остались товары.');
    }
});

adminRouter.get('/users', async (req, res) => {
    try {
        const query = `
            SELECT id, name, email, phone, role, created_at, is_verified
            FROM users
            ORDER BY
                CASE role
                    WHEN 'admin' THEN 1
                    WHEN 'cashier' THEN 2
                    WHEN 'cook' THEN 3
                    WHEN 'courier' THEN 4
                    ELSE 5
                END,
                created_at DESC
        `;
        const result = await sqlQuery(query);
        
        res.render('admin/users', {
            title: 'Управление пользователями',
            users: result.rows
        });
    } catch (error) {
        console.error("Ошибка загрузки пользователей:", error);
        res.status(500).send("Ошибка сервера");
    }
});

adminApiRouter.get('/users/form/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await sqlQuery('SELECT id, name, email, role FROM users WHERE id = $1', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).send('Пользователь не найден');
        }
        
        res.render('admin/partials/user_form_content', {
            user: result.rows[0],
            action: `/admin/api/users/edit/${id}`,
            buttonText: 'Сохранить изменения'
        });
    } catch (error) {
        console.error("Ошибка при запросе формы пользователя:", error);
        res.status(500).send('Ошибка сервера');
    }
});

adminApiRouter.post('/users/edit/:id', async (req, res) => {
    const { id } = req.params;
    const { role } = req.body;

    try {
        if (req.session.user.id == id && role !== 'admin') {
            return res.json({ success: false, message: 'Вы не можете снять права администратора с самого себя.' });
        }

        await sqlQuery('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
        res.json({ success: true });
    } catch (error) {
        console.error("Ошибка при обновлении пользователя:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

adminRouter.get('/promocodes', async (req, res) => {
    try {
        const result = await sqlQuery('SELECT * FROM promocodes ORDER BY id DESC');
        res.render('admin/promocodes', {
            title: 'Управление промокодами',
            promocodes: result.rows
        });
    } catch (error) {
        console.error("Ошибка загрузки промокодов:", error);
        res.status(500).send("Ошибка сервера");
    }
});

adminRouter.post('/promocodes/delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await sqlQuery('DELETE FROM promocodes WHERE id = $1', [id]);
        res.redirect('/admin/promocodes');
    } catch (error) {
        console.error("Ошибка при удалении промокода:", error);
        res.status(500).send("Не удалось удалить промокод.");
    }
});


adminApiRouter.get('/promocodes/form', (req, res) => {
    res.render('admin/partials/promocode_form_content', {
        promocode: {},
        action: '/admin/api/promocodes/new',
        buttonText: 'Создать промокод'
    });
});

adminApiRouter.get('/promocodes/form/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await sqlQuery('SELECT * FROM promocodes WHERE id = $1', [id]);
        
        if (result.rows.length === 0) return res.status(404).send('Промокод не найден');
        
        res.render('admin/partials/promocode_form_content', {
            promocode: result.rows[0],
            action: `/admin/api/promocodes/edit/${id}`,
            buttonText: 'Сохранить изменения'
        });
    } catch (error) {
        res.status(500).send('Ошибка сервера');
    }
});

adminApiRouter.post('/promocodes/new', async (req, res) => {
    let { code, discount_percent, valid_from, valid_to } = req.body;
    const is_active = req.body.is_active === 'on';

    try {
        code = code.trim().toUpperCase();

        const validFromValue = valid_from ? valid_from : null;
        const validToValue = valid_to ? valid_to : null;

        await sqlQuery(
            'INSERT INTO promocodes (code, discount_percent, is_active, valid_from, valid_to) VALUES ($1, $2, $3, $4, $5)',
            [code, discount_percent, is_active, validFromValue, validToValue] // Добавляем даты в запрос
        );
        res.json({ success: true });
    } catch (error) {
        if (error.code === '23505') {
            return res.json({ success: false, message: 'Промокод с таким названием уже существует' });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

adminApiRouter.post('/promocodes/edit/:id', async (req, res) => {
    const { id } = req.params;
    let { code, discount_percent, valid_from, valid_to } = req.body;
    const is_active = req.body.is_active === 'on';

    try {
        code = code.trim().toUpperCase();

        const validFromValue = valid_from ? valid_from : null;
        const validToValue = valid_to ? valid_to : null;

        await sqlQuery(
            'UPDATE promocodes SET code = $1, discount_percent = $2, is_active = $3, valid_from = $4, valid_to = $5 WHERE id = $6',
            [code, discount_percent, is_active, validFromValue, validToValue, id] // Добавляем даты
        );
        res.json({ success: true });
    } catch (error) {
         if (error.code === '23505') {
            return res.json({ success: false, message: 'Промокод с таким названием уже существует' });
        }
        res.status(500).json({ success: false, message: error.message });
    }
});

adminRouter.get('/reviews', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        let query = `
            SELECT 
                o.id, o.created_at, o.contact_name, o.contact_phone, o.rating, o.review_text, o.is_review_replied,
                u.email
            FROM orders o
            LEFT JOIN users u ON o.user_id = u.id
            WHERE o.rating IS NOT NULL
        `;
        
        const params = [];
        let paramIndex = 1;

        if (startDate) {
            query += ` AND o.created_at >= $${paramIndex}`;
            params.push(startDate + ' 00:00:00');
            paramIndex++;
        }
        if (endDate) {
            query += ` AND o.created_at <= $${paramIndex}`;
            params.push(endDate + ' 23:59:59');
            paramIndex++;
        }

        query += ` ORDER BY o.created_at DESC`;

        const result = await sqlQuery(query, params);
        const pendingReviews = result.rows.filter(r => !r.is_review_replied);
        const repliedReviews = result.rows.filter(r => r.is_review_replied);

        res.render('admin/reviews', {
            title: 'Отзывы клиентов',
            pendingReviews,
            repliedReviews,
            filters: { startDate, endDate }
        });
    } catch (error) {
        console.error("Ошибка загрузки отзывов:", error);
        res.status(500).send("Ошибка сервера");
    }
});

adminApiRouter.get('/reviews/reply-form/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const result = await sqlQuery(`
            SELECT o.id, o.contact_name, u.email 
            FROM orders o LEFT JOIN users u ON o.user_id = u.id WHERE o.id = $1
        `, [orderId]);
        if (result.rows.length === 0) return res.status(404).send('Заказ не найден');

        res.render('admin/partials/review_reply_form_content', {
            order: result.rows[0],
            action: '/admin/api/reviews/send-email'
        });
    } catch (error) { res.status(500).send('Ошибка сервера'); }
});

adminApiRouter.post('/reviews/send-email', async (req, res) => {
    const { orderId, email, message } = req.body;
    if (!email || !message) return res.json({ success: false, message: 'Заполните текст письма.' });

    try {
        await transporter.sendMail({
            from: '"Якитория" <tvoj_email@gmail.com>',
            to: email,
            subject: `Ответ на ваш отзыв к заказу #${orderId}`,
            html: `<h3>Здравствуйте!</h3><p>${message.replace(/\n/g, '<br>')}</p><hr><small>С уважением, администрация.</small>`
        });

        await sqlQuery('UPDATE orders SET is_review_replied = TRUE WHERE id = $1', [orderId]);

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.json({ success: false, message: 'Ошибка отправки письма' });
    }
});

adminApiRouter.post('/reviews/mark-replied/:orderId', async (req, res) => {
    try {
        await sqlQuery('UPDATE orders SET is_review_replied = TRUE WHERE id = $1', [req.params.orderId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

async function deactivateExpiredPromocodes() {
    try {
        const result = await sqlQuery(
            `UPDATE promocodes 
             SET is_active = FALSE 
             WHERE is_active = TRUE AND valid_to < NOW()`
        );
        if (result.rowCount > 0) {
            console.log(`[Scheduler] Деактивировано ${result.rowCount} просроченных промокодов.`);
        }
    } catch (err) {
        console.error('[Scheduler] Ошибка при деактивации промокодов:', err);
    }
}

// Запускаем проверку раз в минуту
setInterval(deactivateExpiredPromocodes, 60000); 

// --- Запуск сервера ---
server.listen(port, () => {
  console.log(`Сервер и WebSocket запущены на http://localhost:${port}`);
});