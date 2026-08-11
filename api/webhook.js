const { Telegraf, Markup } = require('telegraf');
const connectDB = require('../lib/db');
const { Transaction, Session, Config, PcCommand, Note, Expense } = require('../lib/models');

const bot = new Telegraf(process.env.BOT_TOKEN);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const Groq = require('groq-sdk');
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

const groqTools = [
    {
        type: 'function',
        function: {
            name: 'add_expense',
            description: 'Ghi nhận khoản Thu hoặc Chi tiêu cá nhân mới vào CSDL. Gọi hàm này khi người dùng nói về việc tiêu tiền, mua sắm, trả tiền hoặc nhận tiền, lương, thưởng.',
            parameters: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['INCOME', 'EXPENSE'], description: 'EXPENSE cho chi tiêu, INCOME cho thu nhập' },
                    amount: { type: 'number', description: 'Số tiền tính bằng VNĐ (Ví dụ: 50000, 1500000)' },
                    category: { type: 'string', description: 'Danh mục: Ăn uống, Di chuyển, Hóa đơn & Sinh hoạt, Mua sắm, Giải trí, Lương, Thưởng & Bonus, Đầu tư, Khác' },
                    note: { type: 'string', description: 'Mô tả nội dung khoản thu/chi (Ví dụ: Phở bò, Đổ xăng, Tiền điện)' }
                },
                required: ['type', 'amount', 'category', 'note']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_finance_report',
            description: 'Lấy dữ liệu thống kê tổng thu, tổng chi và số dư theo mốc thời gian.',
            parameters: {
                type: 'object',
                properties: {
                    period: { type: 'string', enum: ['week', 'month', 'year', 'all'], description: 'week (tuần này), month (tháng này), year (năm nay), all (toàn bộ)' }
                },
                required: ['period']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'search_database',
            description: 'Tìm kiếm hoặc xem danh sách đơn hàng CRM hoặc ghi chú lưu trữ trong CSDL.',
            parameters: {
                type: 'object',
                properties: {
                    keyword: { type: 'string', description: 'Từ khóa tìm kiếm (Ví dụ: "Nghĩa", "Netflix", hoặc "all" nếu muốn xem tất cả)' },
                    target: { type: 'string', enum: ['all', 'notes', 'orders'], description: 'Mục tiêu: "notes" nếu người dùng chỉ hỏi xem Ghi chú, "orders" nếu chỉ hỏi xem Đơn hàng CRM, "all" nếu muốn xem cả hai.' }
                },
                required: ['keyword']
            }
        }
    }
];

async function handleGroqAI(ctx, text) {
    if (!groq) {
        await ctx.sendTracked('⚠️ Bot chưa nhận được `GROQ_API_KEY` trên Vercel.\n\nVui lòng vào Vercel Dashboard -> Project Settings -> Environment Variables -> Thêm `GROQ_API_KEY` = `gsk_xE1EB...` rồi Bấm **Redeploy**!');
        return true;
    }
    
    try {
        const messages = [
            {
                role: 'system',
                content: 'Bạn là Trợ lý AI siêu tốc của Garlic Bot. Bạn giao tiếp bằng tiếng Việt thân thiện, tự nhiên, xưng hô Sếp/Em hoặc Bạn/Tôi. Bạn có các Công cụ (Tools) để tự động lưu Thu Chi, lấy Báo cáo tài chính và Tìm kiếm CSDL. Khi người dùng đề cập đến việc chi tiền hoặc thu tiền, hãy tự động gọi hàm add_expense với thông tin tương ứng. Khi người dùng chỉ muốn xem Ghi chú, hãy gọi hàm search_database với target là "notes". Khi người dùng chỉ muốn xem Đơn hàng, hãy gọi search_database với target là "orders".'
            },
            { role: 'user', content: text }
        ];

        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages,
            tools: groqTools,
            tool_choice: 'auto'
        });

        const responseMessage = response.choices[0].message;

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            let toolResults = [];
            
            for (const toolCall of responseMessage.tool_calls) {
                const fnName = toolCall.function.name;
                const args = JSON.parse(toolCall.function.arguments);

                if (fnName === 'add_expense') {
                    let amt = Number(args.amount) || 0;
                    if (amt > 0 && amt < 1000) amt = amt * 1000;
                    
                    const exp = new Expense({
                        type: args.type,
                        amount: amt,
                        category: args.category || 'Khác',
                        note: args.note || (args.type === 'EXPENSE' ? 'Chi tiêu' : 'Thu nhập')
                    });
                    await exp.save();
                    const icon = args.type === 'EXPENSE' ? '💸 CHI' : '💰 THU';
                    toolResults.push(`✅ Đã lưu ${icon}: ${amt.toLocaleString('vi-VN')} VNĐ | [${exp.category}] ${exp.note}`);
                }
                else if (fnName === 'get_finance_report') {
                    const period = args.period || 'month';
                    const now = new Date();
                    let startDate = null;
                    if (period === 'week') {
                        const day = now.getDay();
                        const diffToMonday = now.getDate() - day + (day === 0 ? -6 : 1);
                        startDate = new Date(now.setDate(diffToMonday));
                        startDate.setHours(0, 0, 0, 0);
                    } else if (period === 'year') {
                        startDate = new Date(now.getFullYear(), 0, 1);
                    } else if (period === 'month') {
                        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                    }

                    const query = startDate ? { date: { $gte: startDate } } : {};
                    const items = await Expense.find(query);
                    let inc = 0, exp = 0;
                    items.forEach(i => { if (i.type === 'INCOME') inc += i.amount; else exp += i.amount; });
                    toolResults.push(`📊 Báo cáo (${period}): Tổng Thu = ${inc.toLocaleString()}đ, Tổng Chi = ${exp.toLocaleString()}đ, Dư = ${(inc - exp).toLocaleString()}đ`);
                }
                else if (fnName === 'search_database') {
                    const kw = (args.keyword || '').trim();
                    const target = (args.target || 'all').toLowerCase();
                    
                    let txs = [];
                    let notes = [];
                    const isAllKeyword = !kw || kw.toLowerCase() === 'all' || kw.toLowerCase() === 'tất cả';
                    
                    if (target === 'all' || target === 'orders') {
                        if (isAllKeyword) {
                            txs = await Transaction.find().sort({ saleDate: -1 }).limit(10).lean();
                        } else {
                            txs = await Transaction.find({
                                $or: [
                                    { buyerName: { $regex: kw, $options: 'i' } },
                                    { transactionId: { $regex: kw, $options: 'i' } },
                                    { productName: { $regex: kw, $options: 'i' } },
                                    { sellerName: { $regex: kw, $options: 'i' } }
                                ]
                            }).limit(10).lean();
                        }
                    }
                    
                    if (target === 'all' || target === 'notes') {
                        if (isAllKeyword) {
                            notes = await Note.find().sort({ createdAt: -1 }).limit(10).lean();
                        } else {
                            notes = await Note.find({
                                $or: [
                                    { content: { $regex: kw, $options: 'i' } },
                                    { category: { $regex: kw, $options: 'i' } }
                                ]
                            }).limit(10).lean();
                        }
                    }
                    
                    let detail = `Kết quả dữ liệu tìm thấy:\n`;
                    if (txs.length > 0) {
                        detail += `[DANH SÁCH ĐƠN HÀNG CRM]:\n` + txs.map(t => 
                            `- Mã đơn: ${t.transactionId} | Khách hàng: ${t.buyerName} | Dịch vụ: ${t.productName} | Giá bán: ${t.price?.toLocaleString('vi-VN')}đ | Giá nhập: ${t.importPrice?.toLocaleString('vi-VN')}đ | Hạn: ${t.durationDays} ngày | Ngày mua: ${new Date(t.saleDate).toLocaleDateString('vi-VN')}${t.refundedAmount ? ` | Đã hoàn tiền: ${t.refundedAmount.toLocaleString('vi-VN')}đ` : ''}`
                        ).join('\n') + '\n';
                    }
                    if (notes.length > 0) {
                        detail += `[KHO GHI CHÚ]:\n` + notes.map(n => `- [Danh mục: ${n.category}] Nội dung: ${n.content || '(Chỉ có file đính kèm)'}`).join('\n');
                    }
                    if (txs.length === 0 && notes.length === 0) {
                        detail += `Không tìm thấy dữ liệu phù hợp trong CSDL.`;
                    }
                    toolResults.push(detail);
                }
            }

            messages.push(responseMessage);
            messages.push({
                role: 'tool',
                tool_call_id: responseMessage.tool_calls[0].id,
                content: toolResults.join('\n')
            });

            const finalResponse = await groq.chat.completions.create({
                model: 'llama-3.3-70b-versatile',
                messages
            });

async function sendSafeMarkdown(ctx, text) {
    if (!text) return;
    try {
        await ctx.sendTracked(text, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.sendTracked(text);
    }
}

            await sendSafeMarkdown(ctx, finalResponse.choices[0].message.content);
            return true;
        }

        if (responseMessage.content) {
            await sendSafeMarkdown(ctx, responseMessage.content);
            return true;
        }
    } catch (err) {
        console.error('Lỗi Groq AI:', err);
        if (err.message && err.message.includes('tool_use_failed')) {
            const lower = text.toLowerCase();
            if (lower.includes('tuần') || lower.includes('week')) {
                await generateFinanceReport(ctx, 'week');
                return true;
            }
            if (lower.includes('tháng') || lower.includes('month')) {
                await generateFinanceReport(ctx, 'month');
                return true;
            }
            if (lower.includes('năm') || lower.includes('year')) {
                await generateFinanceReport(ctx, 'year');
                return true;
            }
            if (lower.includes('toàn bộ') || lower.includes('tất cả')) {
                await generateFinanceReport(ctx, 'all');
                return true;
            }
        }
        await ctx.sendTracked(`⚠️ Lỗi Groq AI: ${err.message}`);
        return true;
    }
    return false;
}

let cachedOwnerId = null;

bot.use(async (ctx, next) => {
    const isChannel = !!ctx.channelPost;
    if (!ctx.from && !isChannel) return;
    
    await connectDB();
    
    const ownerPassword = process.env.OWNER_PASSWORD || 'Buicongtoi0902';
    
    // BẢO MẬT BOT - Cache ownerId trong bộ nhớ để không phải truy vấn DB mỗi lần nhắn tin
    if (!cachedOwnerId) {
        let ownerConf = await Config.findOne({ key: 'ownerId' }).lean();
        if (ownerConf) {
            cachedOwnerId = ownerConf.value;
        } else {
            if (ctx.message && ctx.message.text === ownerPassword) {
                ownerConf = new Config({ key: 'ownerId', value: ctx.from.id });
                await ownerConf.save();
                cachedOwnerId = ctx.from.id;
                return ctx.reply('✅ Kích hoạt thành công! Bạn đã được nhận diện là Chủ Nhân của Bot. Gõ /start để bắt đầu.');
            }
            return ctx.reply('🔒 Hệ thống đang khóa. Vui lòng nhập Mật khẩu quản trị để mở khóa Bot:');
        }
    }
    
    // Kiểm tra quyền chủ nhân
    if (!isChannel && ctx.from.id !== cachedOwnerId) {
        return ctx.reply('🚫 Bot này là tài sản cá nhân. Bạn không có quyền truy cập.');
    }

    const userId = isChannel ? ctx.chat.id : ctx.from.id;
    let session = await Session.findOne({ userId }).lean();
    if (!session) {
        session = { userId, state: 'IDLE', data: {}, lastMessages: [] };
        await Session.create(session);
    }
    ctx.session = session;

    ctx.sendTracked = async (text, extra) => { return await ctx.reply(text, extra); };
    ctx.clearOldMessages = async () => {};

    await next();
    await Session.updateOne({ userId }, { state: ctx.session.state, data: ctx.session.data, lastMessages: ctx.session.lastMessages });
});

const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('📝 Tạo Đơn Mới', 'action_create'), Markup.button.callback('🔍 Tra Cứu', 'action_search')],
    [Markup.button.callback('🛠 Bảo Hành', 'action_warranty_list'), Markup.button.callback('👤 Khách Hàng', 'action_search_customer')],
    [Markup.button.callback('📈 Thống Kê CRM', 'action_stats'), Markup.button.callback('💰 Thu Chi Cá Nhân', 'action_personal_finance')],
    [Markup.button.callback('📝 Kho Ghi Chú', 'action_view_notes')]
]);

async function showOrderDetail(ctx, transactionId) {
    const tx = await Transaction.findOne({ transactionId });
    if (!tx) return await ctx.sendTracked('Không tìm thấy đơn hàng.', mainMenu);
    
    const saleDate = new Date(tx.saleDate).toLocaleDateString('vi-VN');
    let caption = `📦 CHI TIẾT ĐƠN HÀNG: ${tx.transactionId}\n\n` +
                  `🧑‍💼 Nguồn nhập: ${tx.sellerName}\n` +
                  `📝 Dịch vụ: ${tx.productName}\n` +
                  `🧑‍💻 Khách hàng: ${tx.buyerName}\n` +
                  `⬇️ Giá nhập: ${tx.importPrice.toLocaleString('vi-VN')} VNĐ\n` +
                  `⬆️ Giá bán: ${tx.price.toLocaleString('vi-VN')} VNĐ\n` +
                  `⏳ Hạn gói: ${tx.durationDays} ngày\n` +
                  `📅 Giao dịch: ${saleDate}`;
    
    if (tx.refundedAmount > 0) {
        caption += `\n\n⚠️ ĐÃ HOÀN TIỀN: ${tx.refundedAmount.toLocaleString('vi-VN')} VNĐ`;
    }
                    
    const actionButtons = Markup.inlineKeyboard([
        [Markup.button.callback('✏ Sửa Đơn Hàng', `editmenu_${tx.transactionId}`), Markup.button.callback('🗑 Xóa Đơn', `delete_${tx.transactionId}`)],
        [Markup.button.callback('🔙 Trở về Menu', 'action_menu')]
    ]);

    let msg;
    if (tx.proofPhotoId) {
        msg = await ctx.replyWithPhoto(tx.proofPhotoId, { caption, ...actionButtons });
    } else {
        msg = await ctx.reply(caption, actionButtons);
    }
    ctx.session.lastMessages.push(msg.message_id);
}

bot.start(async (ctx) => {
    await ctx.clearOldMessages();
    ctx.session.state = 'IDLE';
    ctx.session.data = {};
    await ctx.sendTracked(`- Xin chào Sếp! Hệ thống CRM đã sẵn sàng. 🚀`, mainMenu);
});

bot.command('menu', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.session.state = 'IDLE';
    ctx.session.data = {};
    await ctx.sendTracked('Danh mục quản lý:', mainMenu);
});

bot.command('help', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.session.state = 'IDLE';
    
    const helpText = `💡 **HƯỚNG DẪN SỬ DỤNG BOT THÔNG MINH**

💰 **1️⃣ Ghi nhận Thu Chi Cá Nhân nhanh:**
- **Ghi Khoản Chi:** \`Chi 50k ăn sáng\` hoặc \`-50k phở bò\` hoặc \`Chi 1.5M tiền nhà\`
- **Ghi Khoản Thu:** \`Thu 5M lương\` hoặc \`+500k thưởng\` hoặc \`Thu 2tr\`
*(Bot tự động quy đổi k, M, tr và phân loại danh mục thông minh!)*

📝 **2️⃣ Ghi chú nhanh:**
- **Lưu Ghi chú / Web:** \`Note Nội dung cần ghi nhớ\`
- **Lưu Tài khoản / App:** \`App Tên tài khoản - Mật khẩu\`
- **Lưu Prompt AI:** \`Pr Nội dung prompt\`

🖼 **3️⃣ Lưu Ảnh / File đính kèm:**
- Gửi ảnh/file kèm Caption \`Note\`, \`App\`, hoặc \`Pr\`.

🔍 **4️⃣ Tra cứu nhanh toàn cầu:**
- Cú pháp: \`Tìm Từ khóa\` (hoặc \`Search Từ khóa\`)`;

    await ctx.sendTracked(helpText, { parse_mode: 'Markdown' });
});












bot.action('action_view_notes', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    
    // Lấy danh sách các danh mục hiện có
    const categories = await Note.distinct('category');
    if (categories.length === 0) {
        return await ctx.sendTracked('📝 Kho ghi chú hiện đang trống.', mainMenu);
    }
    
    // Tạo mảng nút bấm cho từng danh mục
    const catButtons = categories.map(cat => [Markup.button.callback(`📁 ${cat}`, `action_notes_cat_${cat}`)]);
    catButtons.push([Markup.button.callback('🔙 Trở về Menu', 'action_menu')]);
    
    const catMenu = Markup.inlineKeyboard(catButtons);
    await ctx.sendTracked('🗂 Vui lòng chọn danh mục Ghi chú bạn muốn xem:', catMenu);
});

bot.action(/^action_notes_cat_(.+)$/, async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    const category = ctx.match[1];
    
    const notes = await Note.find({ category }).sort({ createdAt: -1 }).limit(10);
    if (notes.length === 0) {
        return await ctx.sendTracked(`📂 Danh mục [${category}] trống.`, mainMenu);
    }
    
    let text = `📂 KHO GHI CHÚ: <b>${category.toUpperCase()}</b>\n`;
    text += `<i>(Bấm vào các phím số tương ứng bên dưới để Sửa/Xóa)</i>\n\n`;
    
    const noteButtons = [];
    let row = [];
    
    notes.forEach((n, i) => {
        const date = new Date(n.createdAt).toLocaleDateString('vi-VN');
        text += `<b>${i + 1}.</b> ${n.content}\n`;
        text += `   <i>⏱ ${date}</i>\n\n`;
        
        row.push(Markup.button.callback(`${i + 1}`, `viewnote_${n._id}`));
        if (row.length === 5) {
            noteButtons.push(row);
            row = [];
        }
    });
    if (row.length > 0) noteButtons.push(row);
    
    noteButtons.push([Markup.button.callback('🔙 Quay lại danh mục', 'action_view_notes')]);
    noteButtons.push([Markup.button.callback('🏠 Về Menu chính', 'action_menu')]);
    
    await ctx.sendTracked(text, { reply_markup: { inline_keyboard: noteButtons }, parse_mode: 'HTML' });
});

bot.action(/^viewnote_(.+)$/, async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    const noteId = ctx.match[1];
    const n = await Note.findById(noteId);
    if (!n) return await ctx.sendTracked('Ghi chú không tồn tại.', mainMenu);
    
    const text = `📝 <b>Nội dung:</b>\n${n.content || '(Chỉ có File đính kèm)'}\n\n📁 Danh mục: ${n.category}`;
    
    const btns = Markup.inlineKeyboard([
        [Markup.button.callback('✏ Sửa chữ', `editnote_${noteId}`), Markup.button.callback('🗑 Xóa', `delnote_${noteId}`)],
        [Markup.button.callback('🔙 Danh mục', `action_notes_cat_${n.category}`), Markup.button.callback('🏠 Menu chính', 'action_menu')]
    ]);
    
    let msgObj;
    if (n.fileId) {
        if (n.fileType === 'photo') {
            msgObj = await ctx.replyWithPhoto(n.fileId, { caption: text, parse_mode: 'HTML', reply_markup: btns.reply_markup });
        } else {
            msgObj = await ctx.replyWithDocument(n.fileId, { caption: text, parse_mode: 'HTML', reply_markup: btns.reply_markup });
        }
    } else {
        msgObj = await ctx.reply(text, { reply_markup: btns.reply_markup, parse_mode: 'HTML' });
    }
    ctx.session.lastMessages.push(msgObj.message_id);
});

bot.action(/^delnote_(.+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const noteId = ctx.match[1];
    await Note.findByIdAndDelete(noteId);
    await ctx.reply('🗑 Đã xóa ghi chú!');
    
    await ctx.clearOldMessages();
    await ctx.sendTracked('Danh mục quản lý:', mainMenu);
});

bot.action(/^editnote_(.+)$/, async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    const noteId = ctx.match[1];
    ctx.session.state = 'EDIT_NOTE';
    ctx.session.data.editNoteId = noteId;
    
    await ctx.sendTracked('✏ Vui lòng nhập nội dung mới cho ghi chú này (hoặc gõ Hủy để bỏ qua):');
});

bot.action('action_menu', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.session.state = 'IDLE';
    ctx.session.data = {};
    ctx.answerCbQuery();
    await ctx.sendTracked('Danh mục quản lý:', mainMenu);
});

bot.action('action_close', async (ctx) => {
    try { await ctx.deleteMessage(); } catch(e){}
});

bot.action('action_create', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.session.state = 'CREATE_SELLER_NAME';
    ctx.session.data = {};
    await ctx.sendTracked('Bắt đầu tạo Đơn Hàng.\nVui lòng nhập TÊN NGƯỜI BÁN (hoặc gõ No):');
    ctx.answerCbQuery();
});

bot.action('action_search', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    const latestTx = await Transaction.find().sort({ saleDate: -1 }).limit(100);
    if (latestTx.length === 0) return await ctx.sendTracked('Chưa có đơn hàng.', mainMenu);
    const buttons = latestTx.map(tx => [Markup.button.callback(`🛒 ${tx.transactionId} - ${tx.buyerName}`, `view_${tx.transactionId}`)]);
    buttons.push([Markup.button.callback('🔙 Trở về Menu', 'action_menu')]);
    await ctx.sendTracked(`Danh sách đơn hàng (${latestTx.length}):`, Markup.inlineKeyboard(buttons));
});

bot.action('action_search_customer', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    
    // Lấy danh sách khách hàng (Distinct)
    const distinctCustomers = await Transaction.distinct('buyerName');
    
    if (!distinctCustomers || distinctCustomers.length === 0) {
        return await ctx.sendTracked('Chưa có khách hàng nào trong hệ thống.', mainMenu);
    }
    
    // Lưu vào session để dùng index (do callback_data giới hạn 64 bytes)
    ctx.session.data.customerList = distinctCustomers.slice(0, 50); // Lấy tối đa 50 khách
    
    const buttons = [];
    for (let i = 0; i < ctx.session.data.customerList.length; i++) {
        buttons.push([Markup.button.callback(`👤 ${ctx.session.data.customerList[i]}`, `cust_${i}`)]);
    }
    
    buttons.push([Markup.button.callback('✍️ Gõ tên để tìm...', 'action_search_customer_manual')]);
    buttons.push([Markup.button.callback('🔙 Trở về Menu', 'action_menu')]);
    
    await ctx.sendTracked(`Có ${distinctCustomers.length} khách hàng. Chọn khách hàng để xem lịch sử mua:`, Markup.inlineKeyboard(buttons));
});

bot.action('action_search_customer_manual', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.session.state = 'SEARCH_CUSTOMER';
    await ctx.sendTracked('Vui lòng nhập TÊN KHÁCH HÀNG cần tìm (Nhập 1 phần tên cũng được):');
    ctx.answerCbQuery();
});

bot.action(/^cust_(\d+)$/, async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    
    const idx = parseInt(ctx.match[1]);
    const customerName = ctx.session.data.customerList ? ctx.session.data.customerList[idx] : null;
    
    if (!customerName) {
        return await ctx.sendTracked('Phiên đã hết hạn, vui lòng quay lại menu.', mainMenu);
    }
    
    // Tìm các đơn hàng của khách này
    const txs = await Transaction.find({ buyerName: customerName }).sort({ saleDate: -1 });
    
    if (txs.length === 0) {
        return await ctx.sendTracked(`Không tìm thấy đơn hàng nào của "${customerName}".`, mainMenu);
    }
    
    const buttons = txs.map(tx => [Markup.button.callback(`🛒 ${tx.transactionId} - ${tx.productName}`, `view_${tx.transactionId}`)]);
    buttons.push([Markup.button.callback('🔙 Quay lại danh sách', 'action_search_customer')]);
    
    await ctx.sendTracked(`Lịch sử mua hàng của 👤 ${customerName}:`, Markup.inlineKeyboard(buttons));
});

bot.action('action_warranty_list', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    const latestTx = await Transaction.find().sort({ saleDate: -1 }).limit(100);
    if (latestTx.length === 0) return await ctx.sendTracked('Chưa có đơn hàng.', mainMenu);
    const buttons = latestTx.map(tx => [Markup.button.callback(`🛠 ${tx.transactionId} - ${tx.buyerName}`, `calc_warranty_${tx.transactionId}`)]);
    buttons.push([Markup.button.callback('🔙 Trở về Menu', 'action_menu')]);
    await ctx.sendTracked(`Chọn đơn hàng cần bảo hành (${latestTx.length}):`, Markup.inlineKeyboard(buttons));
});

bot.action('action_stats', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    const allTx = await Transaction.find();
    let totalRevenue = 0, totalImport = 0, totalRefund = 0;
    
    allTx.forEach(tx => {
        totalRevenue += tx.price || 0;
        totalImport += tx.importPrice || 0;
        totalRefund += tx.refundedAmount || 0;
    });
    
    const profit = totalRevenue - (totalImport + totalRefund);
    
    const msg = `📈 BÁO CÁO KINH DOANH TỔNG QUAN (CRM)\n\n` +
                `🔹 Tổng Doanh thu: ${totalRevenue.toLocaleString('vi-VN')} VNĐ\n` +
                `🔹 Tổng Giá nhập: ${totalImport.toLocaleString('vi-VN')} VNĐ\n` +
                `🔹 Đã hoàn tiền: ${totalRefund.toLocaleString('vi-VN')} VNĐ\n\n` +
                `💵 LỢI NHUẬN RÒNG: ${profit.toLocaleString('vi-VN')} VNĐ`;
                
    await ctx.sendTracked(msg, Markup.inlineKeyboard([[Markup.button.callback('🔙 Trở về Menu', 'action_menu')]]));
});

// Chức năng Thu Chi Cá Nhân
bot.action('action_personal_finance', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    ctx.session.state = 'IDLE';
    
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const expenses = await Expense.find({ date: { $gte: firstDay } });
    let totalIncome = 0, totalExpense = 0;
    expenses.forEach(item => {
        if (item.type === 'INCOME') totalIncome += item.amount;
        else totalExpense += item.amount;
    });
    const balance = totalIncome - totalExpense;
    
    const text = `💰 **QUẢN LÝ THU CHI CÁ NHÂN**\n\n` +
                 `📅 **Tháng ${now.getMonth() + 1}/${now.getFullYear()}**:\n` +
                 `🟢 **Tổng Thu:** ${totalIncome.toLocaleString('vi-VN')} VNĐ\n` +
                 `🔴 **Tổng Chi:** ${totalExpense.toLocaleString('vi-VN')} VNĐ\n` +
                 `💵 **Dư Tích Lũy:** ${balance.toLocaleString('vi-VN')} VNĐ\n\n` +
                 `💡 *Mẹo: Bạn có thể nhắn nhanh cho Bot dạng \`Chi 50k ăn sáng\` hoặc \`Thu 5M lương\` bất kỳ lúc nào!*`;

    const buttons = Markup.inlineKeyboard([
        [Markup.button.callback('➖ Thêm Khoản Chi', 'action_finance_add_expense'), Markup.button.callback('➕ Thêm Khoản Thu', 'action_finance_add_income')],
        [Markup.button.callback('📊 Báo Cáo Chi Tiết', 'action_finance_stats'), Markup.button.callback('📋 Giao Dịch Gần Đây', 'action_finance_recent')],
        [Markup.button.callback('🔙 Trở về Menu', 'action_menu')]
    ]);

    await ctx.sendTracked(text, { ...buttons, parse_mode: 'Markdown' });
});

bot.action('action_finance_add_expense', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    ctx.session.state = 'FINANCE_INPUT_AMOUNT';
    ctx.session.data.financeType = 'EXPENSE';
    await ctx.sendTracked('➖ **NHẬP KHOẢN CHI MỚI**\n\nVui lòng nhập SỐ TIỀN (Ví dụ: `50k`, `1.5M`, `150000` hoặc gõ Hủy):', { parse_mode: 'Markdown' });
});

bot.action('action_finance_add_income', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    ctx.session.state = 'FINANCE_INPUT_AMOUNT';
    ctx.session.data.financeType = 'INCOME';
    await ctx.sendTracked('➕ **NHẬP KHOẢN THU MỚI**\n\nVui lòng nhập SỐ TIỀN (Ví dụ: `5M`, `500k`, `5000000` hoặc gõ Hủy):', { parse_mode: 'Markdown' });
});

bot.action(/^fincat_(.+)$/, async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    const category = ctx.match[1];
    ctx.session.data.financeCategory = category;
    ctx.session.state = 'FINANCE_INPUT_NOTE';
    
    await ctx.sendTracked(`Danh mục đã chọn: **${category}**\n\nVui lòng nhập GHI CHÚ (hoặc gõ No nếu không có):`, { parse_mode: 'Markdown' });
});

async function generateFinanceReport(ctx, period = 'month') {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    
    const now = new Date();
    let startDate = null;
    let periodTitle = '';
    
    if (period === 'week') {
        const day = now.getDay();
        const diffToMonday = now.getDate() - day + (day === 0 ? -6 : 1);
        startDate = new Date(now.setDate(diffToMonday));
        startDate.setHours(0, 0, 0, 0);
        periodTitle = 'TUẦN NÀY';
    } else if (period === 'year') {
        startDate = new Date(now.getFullYear(), 0, 1);
        periodTitle = `NĂM ${now.getFullYear()}`;
    } else if (period === 'all') {
        startDate = null;
        periodTitle = 'TOÀN BỘ THỜI GIAN';
    } else {
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        periodTitle = `THÁNG ${now.getMonth() + 1}/${now.getFullYear()}`;
    }
    
    const query = startDate ? { date: { $gte: startDate } } : {};
    const items = await Expense.find(query).sort({ date: -1 });
    
    const timeframeButtons = [
        [
            Markup.button.callback(period === 'week' ? '🔹 Tuần Này' : 'Tuần Này', 'finreport_week'),
            Markup.button.callback(period === 'month' ? '🔹 Tháng Này' : 'Tháng Này', 'finreport_month')
        ],
        [
            Markup.button.callback(period === 'year' ? '🔹 Năm Này' : 'Năm Này', 'finreport_year'),
            Markup.button.callback(period === 'all' ? '🔹 Toàn Bộ' : 'Toàn Bộ', 'finreport_all')
        ]
    ];
    
    if (items.length === 0) {
        const emptyBtns = Markup.inlineKeyboard([
            ...timeframeButtons,
            [Markup.button.callback('🔙 Quay lại Thu Chi', 'action_personal_finance')]
        ]);
        return await ctx.sendTracked(`📊 **BÁO CÁO THU CHI - ${periodTitle}**\n\nChưa có khoản thu chi nào trong mốc thời gian này.`, { ...emptyBtns, parse_mode: 'Markdown' });
    }
    
    let totalIncome = 0;
    let totalExpense = 0;
    const catMap = {};
    
    items.forEach(item => {
        if (item.type === 'INCOME') {
            totalIncome += item.amount;
        } else {
            totalExpense += item.amount;
            catMap[item.category] = (catMap[item.category] || 0) + item.amount;
        }
    });
    
    const balance = totalIncome - totalExpense;
    
    let reportText = `📊 **BÁO CÁO THU CHI - ${periodTitle}**\n\n` +
                     `🟢 **Tổng Thu:** ${totalIncome.toLocaleString('vi-VN')} VNĐ\n` +
                     `🔴 **Tổng Chi:** ${totalExpense.toLocaleString('vi-VN')} VNĐ\n` +
                     `💵 **Dư Tích Lũy:** ${balance.toLocaleString('vi-VN')} VNĐ\n\n` +
                     `📂 **PHÂN BỔ CHI TIÊU THEO DANH MỤC:**\n`;
                     
    if (totalExpense > 0) {
        for (const [cat, amt] of Object.entries(catMap)) {
            const percent = ((amt / totalExpense) * 100).toFixed(1);
            reportText += `- **${cat}**: ${amt.toLocaleString('vi-VN')} VNĐ (${percent}%)\n`;
        }
    } else {
        reportText += `*(Chưa có khoản chi nào trong mốc thời gian này)*\n`;
    }
    
    const btns = Markup.inlineKeyboard([
        ...timeframeButtons,
        [Markup.button.callback('📋 Giao Dịch Gần Đây', 'action_finance_recent')],
        [Markup.button.callback('🔙 Quay lại Thu Chi', 'action_personal_finance'), Markup.button.callback('🏠 Menu chính', 'action_menu')]
    ]);
    
    await ctx.sendTracked(reportText, { ...btns, parse_mode: 'Markdown' });
}

bot.action('action_finance_stats', async (ctx) => { await generateFinanceReport(ctx, 'month'); });
bot.action(/^finreport_(week|month|year|all)$/, async (ctx) => { await generateFinanceReport(ctx, ctx.match[1]); });

bot.action('action_finance_recent', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    
    const recent = await Expense.find().sort({ date: -1 }).limit(15);
    if (recent.length === 0) {
        return await ctx.sendTracked('Chưa có giao dịch thu chi nào.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Quay lại Thu Chi', 'action_personal_finance')]]));
    }
    
    let text = `📋 **15 GIAO DỊCH THU CHI GẦN ĐÂY**\n\n`;
    const buttons = [];
    let row = [];
    
    recent.forEach((item, i) => {
        const dateStr = new Date(item.date).toLocaleDateString('vi-VN');
        const icon = item.type === 'INCOME' ? '🟢 +' : '🔴 -';
        text += `**${i + 1}.** ${icon}${item.amount.toLocaleString('vi-VN')}đ | [${item.category}] ${item.note || ''} _(${dateStr})_\n`;
        
        row.push(Markup.button.callback(`🗑 Xóa ${i + 1}`, `delfinance_${item._id}`));
        if (row.length === 3) {
            buttons.push(row);
            row = [];
        }
    });
    if (row.length > 0) buttons.push(row);
    
    buttons.push([Markup.button.callback('🔙 Quay lại Thu Chi', 'action_personal_finance'), Markup.button.callback('🏠 Menu chính', 'action_menu')]);
    
    await ctx.sendTracked(text, { reply_markup: { inline_keyboard: buttons }, parse_mode: 'Markdown' });
});

bot.action(/^delfinance_(.+)$/, async (ctx) => {
    ctx.answerCbQuery();
    const id = ctx.match[1];
    await Expense.findByIdAndDelete(id);
    await ctx.reply('🗑 Đã xóa khoản thu chi!');
    
    await ctx.clearOldMessages();
    await ctx.sendTracked('Danh mục quản lý:', mainMenu);
});

bot.action(/^view_(.+)$/, async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    await showOrderDetail(ctx, ctx.match[1]);
});

bot.action(/^delete_(.+)$/, async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    await Transaction.deleteOne({ transactionId: ctx.match[1] });
    await ctx.reply(`🗑 Đã xóa đơn hàng ${ctx.match[1]}!`);
    
    await ctx.sendTracked('Danh mục:', mainMenu);
});

// Xử lý bảo hành & Hoàn tiền
bot.action(/^calc_warranty_(.+)$/, async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    const tx = await Transaction.findOne({ transactionId: ctx.match[1] });
    if (!tx) return await ctx.sendTracked('Không tìm thấy đơn hàng này.', mainMenu);
    
    ctx.session.data.warrantyTxId = tx.transactionId;
    ctx.session.state = 'WARRANTY_INPUT_DAYS';
    
    return await ctx.sendTracked(`Đơn hàng ${tx.transactionId} - ${tx.buyerName}.\nKhách hàng báo lỗi vào lúc nào?\n\n👉 Bạn có thể nhập:\n- Số ngày đã dùng: VD "5"\n- Hoặc Ngày báo lỗi: VD "21/06"\n- Hoặc "Nay": Tính đến hôm nay`, Markup.inlineKeyboard([[Markup.button.callback('🔙 Trở về Menu', 'action_menu')]]));
});

bot.action('confirm_refund', async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    if (!ctx.session.data.warrantyTxId) return;
    await Transaction.updateOne(
        { transactionId: ctx.session.data.warrantyTxId }, 
        { refundedAmount: ctx.session.data.refundAmount }
    );
    await ctx.reply(`✅ Đã cập nhật tiền hoàn vào CSDL để trừ Lợi Nhuận!`);
    
    await showOrderDetail(ctx, ctx.session.data.warrantyTxId);
});

// Menu Sửa Đơn Hàng
bot.action(/^editmenu_(.+)$/, async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    const id = ctx.match[1];
    const buttons = Markup.inlineKeyboard([
        [Markup.button.callback('Người Bán', `editfield_seller_${id}`), Markup.button.callback('Dịch Vụ', `editfield_product_${id}`)],
        [Markup.button.callback('Khách Hàng', `editfield_buyer_${id}`), Markup.button.callback('Ảnh', `editfield_photo_${id}`)],
        [Markup.button.callback('Giá Nhập', `editfield_import_${id}`), Markup.button.callback('Giá Bán', `editfield_price_${id}`)],
        [Markup.button.callback('Hạn Gói', `editfield_duration_${id}`), Markup.button.callback('🔙 Quay Lại', `view_${id}`)]
    ]);
    await ctx.sendTracked(`Bạn muốn sửa thông tin gì của đơn ${id}?`, buttons);
});

bot.action(/^editfield_(.+)_(.+)$/, async (ctx) => {
    await ctx.clearOldMessages();
    ctx.answerCbQuery();
    const field = ctx.match[1];
    ctx.session.data.editId = ctx.match[2];
    
    if (field === 'seller') { ctx.session.state = 'EDIT_SELLER'; return await ctx.sendTracked('Nhập Tên Người Bán mới:'); }
    if (field === 'product') { ctx.session.state = 'EDIT_PRODUCT'; return await ctx.sendTracked('Nhập Dịch Vụ mới:'); }
    if (field === 'buyer') { ctx.session.state = 'EDIT_BUYER'; return await ctx.sendTracked('Nhập Tên Khách mới:'); }
    if (field === 'import') { ctx.session.state = 'EDIT_IMPORT'; return await ctx.sendTracked('Nhập Giá Nhập mới (Số):'); }
    if (field === 'price') { ctx.session.state = 'EDIT_PRICE'; return await ctx.sendTracked('Nhập Giá Bán mới (Số):'); }
    if (field === 'duration') { ctx.session.state = 'EDIT_DURATION'; return await ctx.sendTracked('Nhập Thời Gian Sử Dụng mới (Số):'); }
    if (field === 'photo') { ctx.session.state = 'EDIT_PHOTO'; return await ctx.sendTracked('Gửi Ảnh Bằng Chứng mới:'); }
});

function parseAmount(str) {
    if (!str) return NaN;
    let cleaned = str.trim().toLowerCase();
    
    let multiplier = 1;
    if (cleaned.endsWith('k')) {
        multiplier = 1000;
        cleaned = cleaned.slice(0, -1);
    } else if (cleaned.endsWith('m') || cleaned.endsWith('tr')) {
        multiplier = 1000000;
        if (cleaned.endsWith('tr')) {
            cleaned = cleaned.slice(0, -2);
        } else {
            cleaned = cleaned.slice(0, -1);
        }
    }
    
    cleaned = cleaned.replace(/,/g, '.');
    if (/^\d{1,3}(\.\d{3})+$/.test(cleaned)) {
        cleaned = cleaned.replace(/\./g, '');
    }
    
    const num = parseFloat(cleaned);
    if (isNaN(num) || num <= 0) return NaN;
    return Math.round(num * multiplier);
}

function detectCategory(noteText, type) {
    if (!noteText) return type === 'EXPENSE' ? 'Khác' : 'Khác';
    const text = noteText.toLowerCase().trim();

    if (type === 'INCOME') {
        if (/lương|salary|luong/.test(text)) return 'Lương';
        if (/thưởng|thuong|bonus|hoa hồng|hoa hong|tip/.test(text)) return 'Thưởng & Bonus';
        if (/lãi|lai|đầu tư|dau tu|chứng khoán|crypto|cổ tức/.test(text)) return 'Đầu tư';
        return 'Khác';
    } else {
        if (/xăng|xe|grab|taxi|bus|xe máy|gửi xe|đỗ xe|bảo dưỡng|sửa xe|thay nhớt|vé xe|tàu|máy bay/.test(text)) return 'Di chuyển';
        if (/điện|nước|internet|wifi|tiền nhà|phòng|chung cư|rác|dịch vụ|phí|mạng|tiền điện|tiền nước/.test(text)) return 'Hóa đơn & Sinh hoạt';
        if (/cơm|phở|bún|mì|lẩu|nướng|nhậu|cafe|cà phê|trà sữa|bánh|tối|chè|nước|singum|kẹo|bún đậu|bánh mì|đồ ăn|quán/.test(text) || /(^|\s)ăn(\s|$)/.test(text)) return 'Ăn uống';
        if (/quần|áo|giày|dép|shopee|lazada|tiki|siêu thị|chợ|đồ dùng|mỹ phẩm|son|kem|mua|sắm|tủ|bàn|ghế/.test(text)) return 'Mua sắm';
        if (/phim|game|nạp|du lịch|karaoke|sách|vé|chơi|vui chơi/.test(text)) return 'Giải trí';
        return 'Khác';
    }
}

function handleTextValue(text, isNumber = false) {
    if (text.toLowerCase() === 'no') return isNumber ? 0 : '(Trống)';
    return isNumber ? Number(text) : text;
}

bot.on(['text', 'channel_post'], async (ctx) => {
    const msg = ctx.message || ctx.channelPost;
    if (!msg || !msg.text) return; // Bỏ qua nếu không phải tin nhắn chữ
    const text = msg.text;
    const lowerText = text.toLowerCase().trim();
    console.log("RECEIVED TEXT:", text);
    console.log("LOWER TEXT:", lowerText);
    
    if (['hủy', 'huy', 'cancel', 'thoát', 'thoat', '/start', '/menu'].includes(lowerText)) {
        await ctx.clearOldMessages();
        ctx.session.state = 'IDLE';
        ctx.session.data = {};
        if (lowerText === '/start' || lowerText === '/menu') {
            return await ctx.sendTracked('Danh mục quản lý:', mainMenu);
        }
        return await ctx.sendTracked('🚫 Đã hủy thao tác!\n\nDanh mục quản lý:', mainMenu);
    }

    // Tính năng Ghi chú thông minh (Lệnh toàn cục, hoạt động ở mọi trạng thái)
    const noteMatch = text.match(/^note[:\s\n]+([\s\S]+)$/i);
    const appMatch = text.match(/^app[:\s\n]+([\s\S]+)$/i);
    const prMatch = text.match(/^pr[:\s\n]+([\s\S]+)$/i);

    // Cú pháp nhanh Thu Chi Cá Nhân: "Chi 50k ăn sáng", "-50k phở", "Thu 5M lương", "+500k thưởng"
    const chiMatch = text.match(/^(?:chi|-)\s*([\d\.,]+[kKmMtRtr]*)\s*(.*)$/i);
    const thuMatch = text.match(/^(?:thu|\+)\s*([\d\.,]+[kKmMtRtr]*)\s*(.*)$/i);

    if (chiMatch || thuMatch) {
        const isExpense = !!chiMatch;
        const match = isExpense ? chiMatch : thuMatch;
        const amountStr = match[1];
        const rawNote = match[2] ? match[2].trim() : '';
        const amount = parseAmount(amountStr);
        
        if (!isNaN(amount) && amount > 0) {
            const type = isExpense ? 'EXPENSE' : 'INCOME';
            const category = detectCategory(rawNote, type);
            const note = rawNote || (isExpense ? 'Chi tiêu' : 'Thu nhập');
            
            const exp = new Expense({ type, amount, category, note });
            await exp.save();
            
            ctx.session.state = 'IDLE';
            const icon = isExpense ? '💸 CHI' : '💰 THU';
            const msgText = `✅ **ĐÃ GHI NHẬN KHOẢN ${icon}**\n\n` +
                            `💵 **Số tiền:** ${amount.toLocaleString('vi-VN')} VNĐ\n` +
                            `📁 **Danh mục:** ${category}\n` +
                            `📝 **Ghi chú:** ${note}\n` +
                            `📅 **Thời gian:** ${new Date().toLocaleDateString('vi-VN')}`;
            
            const btns = Markup.inlineKeyboard([
                [Markup.button.callback('🗑 Xóa khoản này', `delfinance_${exp._id}`)],
                [Markup.button.callback('📊 Báo Cáo Thu Chi', 'action_finance_stats'), Markup.button.callback('🏠 Menu chính', 'action_menu')]
            ]);
            
            return await ctx.sendTracked(msgText, { ...btns, parse_mode: 'Markdown' });
        }
    }

    if (noteMatch) {
        const content = noteMatch[1].trim();
        const urlRegex = /^(https?:\/\/)?([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/;
        // Kiểm tra xem trong nội dung có chứa domain/URL không
        const category = urlRegex.test(content.split(' ')[0]) || content.includes('.com') || content.includes('.vn') || content.includes('.top') ? 'Trang web' : 'Ghi chú';
        
        const newNote = new Note({ content, category });
        await newNote.save();
        ctx.session.state = 'IDLE'; // Reset state để tránh lỗi kẹt luồng cũ
        return await ctx.reply(`✅ Đã phân loại và lưu: [${category}]\nNội dung: ${content}`);
    } 
    else if (appMatch) {
        const content = appMatch[1].trim();
        const newNote = new Note({ content, category: 'App' });
        await newNote.save();
        ctx.session.state = 'IDLE';
        return await ctx.reply(`✅ Đã lưu vào mục: [App]\nNội dung: ${content}`);
    } 
    else if (prMatch) {
        const content = prMatch[1].trim();
        const newNote = new Note({ content, category: 'Prompt' });
        await newNote.save();
        ctx.session.state = 'IDLE';
        return await ctx.reply(`✅ Đã lưu vào mục: [Prompt]\nNội dung: ${content}`);
    }
    
    const searchMatch = text.match(/^(?:tìm|tìm kiếm|filter|search)[:\s\n]+([\s\S]+)$/i);
    if (searchMatch) {
        const keyword = searchMatch[1].trim();
        const txs = await Transaction.find({
            $or: [
                { transactionId: { $regex: keyword, $options: 'i' } },
                { buyerName: { $regex: keyword, $options: 'i' } },
                { productName: { $regex: keyword, $options: 'i' } },
                { sellerName: { $regex: keyword, $options: 'i' } }
            ]
        }).limit(10);
        
        const notes = await Note.find({ content: { $regex: keyword, $options: 'i' } }).limit(10);
        
        ctx.session.state = 'IDLE';
        
        if (txs.length > 0 || notes.length > 0) {
            let replyText = `🔍 <b>KẾT QUẢ TÌM KIẾM: "${keyword}"</b>\n\n`;
            const buttons = [];
            
            if (txs.length > 0) {
                replyText += `🛒 <b>ĐƠN HÀNG (${txs.length}):</b>\n`;
                txs.forEach((tx, i) => {
                    replyText += `<b>${i + 1}.</b> ${tx.transactionId} - ${tx.productName} (Khách: ${tx.buyerName})\n`;
                    buttons.push([Markup.button.callback(`🛒 Xem Đơn ${tx.transactionId}`, `view_${tx.transactionId}`)]);
                });
                replyText += `\n`;
            }
            
            if (notes.length > 0) {
                replyText += `📝 <b>GHI CHÚ (${notes.length}):</b>\n`;
                let noteRow = [];
                notes.forEach((n, i) => {
                    const date = new Date(n.createdAt).toLocaleDateString('vi-VN');
                    let shortContent = n.content.length > 40 ? n.content.substring(0, 40) + '...' : n.content;
                    replyText += `<b>${i + 1}.</b> [${n.category}] ${shortContent} <i>(${date})</i>\n`;
                    noteRow.push(Markup.button.callback(`📝 Xem GC ${i + 1}`, `viewnote_${n._id}`));
                    if (noteRow.length === 2) {
                        buttons.push(noteRow);
                        noteRow = [];
                    }
                });
                if (noteRow.length > 0) buttons.push(noteRow);
            }
            
            buttons.push([Markup.button.callback('🔙 Menu chính', 'action_menu')]);
            
            return await ctx.sendTracked(replyText, { reply_markup: { inline_keyboard: buttons }, parse_mode: 'HTML' });
        }
        // Nếu không có kết quả khớp tuyệt đối, để luồng chảy xuống Groq AI xử lý tự nhiên!
    }

    const state = ctx.session.state;
    if (state === 'IDLE') {
        const handledByAI = await handleGroqAI(ctx, text);
        if (handledByAI) return;
        return;
    }

    await ctx.clearOldMessages();
    
    // Luồng nhập Thu Chi Cá Nhân thủ công
    if (state === 'FINANCE_INPUT_AMOUNT') {
        const amount = parseAmount(text);
        if (isNaN(amount) || amount <= 0) {
            return await ctx.sendTracked('⚠️ Số tiền không hợp lệ. Vui lòng nhập dạng `50k`, `1.5M`, `200000` (hoặc gõ Hủy):');
        }
        ctx.session.data.financeAmount = amount;
        ctx.session.state = 'FINANCE_SELECT_CATEGORY';
        
        const isExpense = ctx.session.data.financeType === 'EXPENSE';
        const categories = isExpense 
            ? ['Ăn uống', 'Di chuyển', 'Hóa đơn & Sinh hoạt', 'Mua sắm', 'Giải trí', 'Khác']
            : ['Lương', 'Thưởng & Bonus', 'Đầu tư', 'Khác'];
            
        const catButtons = categories.map(cat => [Markup.button.callback(cat, `fincat_${cat}`)]);
        catButtons.push([Markup.button.callback('🔙 Hủy', 'action_personal_finance')]);
        
        return await ctx.sendTracked(`Đã nhận: **${amount.toLocaleString('vi-VN')} VNĐ**.\n\nVui lòng chọn DANH MỤC:`, Markup.inlineKeyboard(catButtons));
    }

    if (state === 'FINANCE_INPUT_NOTE') {
        const noteText = lowerText === 'no' ? (ctx.session.data.financeType === 'EXPENSE' ? 'Chi tiêu' : 'Thu nhập') : text;
        const exp = new Expense({
            type: ctx.session.data.financeType,
            amount: ctx.session.data.financeAmount,
            category: ctx.session.data.financeCategory,
            note: noteText
        });
        await exp.save();
        
        ctx.session.state = 'IDLE';
        const icon = ctx.session.data.financeType === 'EXPENSE' ? '💸 CHI' : '💰 THU';
        await ctx.reply(`✅ **ĐÃ GHI NHẬN KHOẢN ${icon}**\n\n` +
                        `💵 **Số tiền:** ${exp.amount.toLocaleString('vi-VN')} VNĐ\n` +
                        `📁 **Danh mục:** ${exp.category}\n` +
                        `📝 **Ghi chú:** ${exp.note}`);
                        
        return await ctx.sendTracked('Quản lý thu chi:', Markup.inlineKeyboard([
            [Markup.button.callback('📊 Báo Cáo Tháng', 'action_finance_stats'), Markup.button.callback('💰 Thu Chi Cá Nhân', 'action_personal_finance')],
            [Markup.button.callback('🏠 Menu chính', 'action_menu')]
        ]));
    }

    // Nhập số ngày bảo hành thủ công
    if (state === 'WARRANTY_INPUT_DAYS') {
        const tx = await Transaction.findOne({ transactionId: ctx.session.data.warrantyTxId });
        if (!tx) {
            ctx.session.state = 'IDLE';
            return await ctx.sendTracked('Lỗi: Không tìm thấy đơn hàng.', mainMenu);
        }
        
        let diffDays = 0;
        let saleDateStr = new Date(tx.saleDate).toLocaleDateString('vi-VN');
        let errorDateStr = "";

        if (lowerText === 'nay') {
            const saleDate = new Date(tx.saleDate);
            const currentDate = new Date();
            errorDateStr = currentDate.toLocaleDateString('vi-VN');
            diffDays = Math.ceil((currentDate - saleDate) / (1000 * 60 * 60 * 24)); 
        } else if (text.includes('/')) {
            // Nhập định dạng ngày tháng
            const parts = text.split('/');
            let day = parseInt(parts[0]);
            let month = parseInt(parts[1]) - 1; 
            let year = parts[2] ? parseInt(parts[2]) : new Date().getFullYear();
            if (year < 100) year += 2000;
            
            const errorDate = new Date(year, month, day);
            const saleDate = new Date(tx.saleDate);
            errorDateStr = errorDate.toLocaleDateString('vi-VN');
            
            if (errorDate < saleDate) {
                return await ctx.sendTracked('Ngày báo lỗi không thể TRƯỚC ngày mua. Vui lòng nhập lại:');
            }
            diffDays = Math.ceil((errorDate - saleDate) / (1000 * 60 * 60 * 24)); 
        } else {
            if (isNaN(text)) return await ctx.sendTracked('Vui lòng nhập Ngày (VD: 21/06) hoặc Số ngày đã dùng (VD: 5), hoặc "Nay":');
            diffDays = parseInt(text);
            const errorDate = new Date(tx.saleDate);
            errorDate.setDate(errorDate.getDate() + diffDays);
            errorDateStr = errorDate.toLocaleDateString('vi-VN');
        }
        
        // Tránh lỗi ngày bị âm hoặc tính quá nhanh
        if (diffDays < 0) diffDays = 0;
        
        let pricePerDay = 0;
        let usedAmount = 0;
        let refundAmount = 0;
        let remainingDays = 0;
        
        if (tx.durationDays > 0) {
            pricePerDay = Math.round(tx.price / tx.durationDays);
            if (diffDays <= tx.durationDays) {
                usedAmount = Math.round((tx.price / tx.durationDays) * diffDays);
                refundAmount = tx.price - usedAmount;
                remainingDays = tx.durationDays - diffDays;
            } else {
                usedAmount = tx.price;
                remainingDays = 0;
            }
        }
        
        ctx.session.data.refundAmount = refundAmount;
        ctx.session.state = 'IDLE';
        
        const btns = [
            [Markup.button.callback(`✅ Xác nhận đã Hoàn: ${refundAmount.toLocaleString()}đ`, `confirm_refund`)],
            [Markup.button.callback('🔙 Trở về Menu', 'action_menu')]
        ];
        
        const msg = `🛠 BÁO CÁO BẢO HÀNH\n\n` +
                    `Mã ĐH: ${tx.transactionId}\n` +
                    `Khách hàng: ${tx.buyerName}\n` +
                    `📅 Ngày mua: ${saleDateStr}\n` +
                    `📅 Báo lỗi: ${errorDateStr}\n\n` +
                    `Giá bán: ${tx.price.toLocaleString('vi-VN')}đ / ${tx.durationDays} ngày\n` +
                    `➡ Đơn giá: ${pricePerDay.toLocaleString('vi-VN')}đ / ngày\n\n` +
                    `Đã dùng: ${diffDays} ngày (Hết ${usedAmount.toLocaleString('vi-VN')}đ)\n` +
                    `Còn lại: ${remainingDays} ngày\n\n` +
                    `💰 SỐ TIỀN CẦN HOÀN: ${refundAmount.toLocaleString('vi-VN')} VNĐ`;

        return await ctx.sendTracked(msg, Markup.inlineKeyboard(btns));
    }

    // Tìm kiếm khách hàng
    if (state === 'SEARCH_CUSTOMER') {
        const query = text;
        const txs = await Transaction.find({ buyerName: { $regex: query, $options: 'i' } }).sort({ saleDate: -1 });
        ctx.session.state = 'IDLE';
        
        if (txs.length === 0) {
            return await ctx.sendTracked(`Không tìm thấy khách hàng nào khớp với "${query}".`, mainMenu);
        }
        
        const buttons = txs.map(tx => [Markup.button.callback(`🛒 ${tx.transactionId} - ${tx.productName}`, `view_${tx.transactionId}`)]);
        buttons.push([Markup.button.callback('🔙 Trở về Menu', 'action_menu')]);
        return await ctx.sendTracked(`Tìm thấy ${txs.length} đơn hàng của "${query}":`, Markup.inlineKeyboard(buttons));
    }

    // Luồng tạo mới
    if (state === 'CREATE_SELLER_NAME') {
        ctx.session.data.sellerName = handleTextValue(text);
        ctx.session.state = 'CREATE_PRODUCT_NAME';
        return await ctx.sendTracked('Vui lòng nhập THÔNG TIN DỊCH VỤ (hoặc No):');
    }
    if (state === 'CREATE_PRODUCT_NAME') {
        ctx.session.data.productName = handleTextValue(text);
        ctx.session.state = 'CREATE_PROOF_PHOTO';
        return await ctx.sendTracked('Vui lòng gửi ẢNH GIAO DỊCH (hoặc gõ No):');
    }
    if (state === 'CREATE_PROOF_PHOTO' && lowerText === 'no') {
        ctx.session.data.proofPhotoId = '';
        ctx.session.state = 'CREATE_BUYER_NAME';
        return await ctx.sendTracked('Đã bỏ qua ảnh. Vui lòng nhập TÊN KHÁCH HÀNG:');
    }
    if (state === 'CREATE_BUYER_NAME') {
        ctx.session.data.buyerName = handleTextValue(text);
        ctx.session.state = 'CREATE_IMPORT_PRICE';
        return await ctx.sendTracked('Vui lòng nhập GIÁ NHẬP VÀO (Ví dụ: 15000):');
    }
    if (state === 'CREATE_IMPORT_PRICE') {
        if (lowerText !== 'no' && isNaN(text)) return await ctx.sendTracked('Vui lòng nhập SỐ:');
        ctx.session.data.importPrice = handleTextValue(text, true);
        ctx.session.state = 'CREATE_PRICE';
        return await ctx.sendTracked('Vui lòng nhập GIÁ BÁN CHO KHÁCH (Ví dụ: 30000):');
    }
    if (state === 'CREATE_PRICE') {
        if (lowerText !== 'no' && isNaN(text)) return await ctx.sendTracked('Vui lòng nhập SỐ:');
        ctx.session.data.price = handleTextValue(text, true);
        ctx.session.state = 'CREATE_DURATION';
        return await ctx.sendTracked('Vui lòng nhập SỐ NGÀY SỬ DỤNG (Ví dụ: 30):');
    }
    if (state === 'CREATE_DURATION') {
        if (lowerText !== 'no' && isNaN(text)) return await ctx.sendTracked('Vui lòng nhập SỐ:');
        ctx.session.data.durationDays = handleTextValue(text, true);
        
        const transactionId = 'DH' + Math.floor(1000 + Math.random() * 9000);
        const tx = new Transaction({
            transactionId,
            sellerName: ctx.session.data.sellerName,
            productName: ctx.session.data.productName,
            proofPhotoId: ctx.session.data.proofPhotoId,
            buyerName: ctx.session.data.buyerName,
            importPrice: ctx.session.data.importPrice,
            price: ctx.session.data.price,
            durationDays: ctx.session.data.durationDays
        });
        await tx.save();
        
        ctx.session.state = 'IDLE';
        await ctx.reply(`✅ TẠO ĐƠN THÀNH CÔNG!\n\nMã: ${transactionId}`);
        
        await ctx.sendTracked('Mời bạn chọn thao tác tiếp theo:', mainMenu);
        return;
    }

    // Luồng sửa đơn
    if (state.startsWith('EDIT_')) {
        const id = ctx.session.data.editId;
        const updateData = {};
        if (state === 'EDIT_SELLER') updateData.sellerName = handleTextValue(text);
        if (state === 'EDIT_PRODUCT') updateData.productName = handleTextValue(text);
        if (state === 'EDIT_BUYER') updateData.buyerName = handleTextValue(text);
        if (state === 'EDIT_IMPORT') {
            if (lowerText !== 'no' && isNaN(text)) return await ctx.sendTracked('Vui lòng nhập SỐ:');
            updateData.importPrice = handleTextValue(text, true);
        }
        if (state === 'EDIT_PRICE') {
            if (lowerText !== 'no' && isNaN(text)) return await ctx.sendTracked('Vui lòng nhập SỐ:');
            updateData.price = handleTextValue(text, true);
        }
        if (state === 'EDIT_DURATION') {
            if (lowerText !== 'no' && isNaN(text)) return await ctx.sendTracked('Vui lòng nhập SỐ:');
            updateData.durationDays = handleTextValue(text, true);
        }
        if (state === 'EDIT_PHOTO' && lowerText === 'no') {
            updateData.proofPhotoId = '';
        }

        await Transaction.updateOne({ transactionId: id }, updateData);
        ctx.session.state = 'IDLE';
        await ctx.reply(`✅ Đã cập nhật thành công!`);
        
        await showOrderDetail(ctx, id);
        return;
    }
});

bot.on(['photo', 'document'], async (ctx) => {
    const msg = ctx.message || ctx.channelPost;
    
    if (ctx.session.state === 'CREATE_PROOF_PHOTO' || ctx.session.state === 'EDIT_PHOTO') {
        if (!msg.photo) return await ctx.sendTracked('Vui lòng gửi ẢNH (không phải file).');
        await ctx.clearOldMessages();
        const photoId = msg.photo[msg.photo.length - 1].file_id;
        
        if (ctx.session.state === 'CREATE_PROOF_PHOTO') {
            ctx.session.data.proofPhotoId = photoId;
            ctx.session.state = 'CREATE_BUYER_NAME';
            return await ctx.sendTracked('Đã lưu ảnh. Vui lòng nhập TÊN KHÁCH HÀNG:');
        } else {
            const id = ctx.session.data.editId;
            await Transaction.updateOne({ transactionId: id }, { proofPhotoId: photoId });
            ctx.session.state = 'IDLE';
            const msgObj = await ctx.reply(`✅ Đã cập nhật ảnh thành công!`);
            
            await showOrderDetail(ctx, id);
        }
        return;
    }

    // Tính năng Ghi chú thông minh kèm Ảnh/File đính kèm
    const text = msg.caption || '';
    if (!text) return; // Không có caption thì bỏ qua

    const noteMatch = text.match(/^note[:\s\n]*([\s\S]*)$/i);
    const appMatch = text.match(/^app[:\s\n]*([\s\S]*)$/i);
    const prMatch = text.match(/^pr[:\s\n]*([\s\S]*)$/i);

    if (!noteMatch && !appMatch && !prMatch) return;

    let fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
    let fileType = msg.photo ? 'photo' : 'document';

    if (noteMatch) {
        const content = noteMatch[1] ? noteMatch[1].trim() : '';
        const category = 'Ghi chú';
        const newNote = new Note({ content, category, fileId, fileType });
        await newNote.save();
        ctx.session.state = 'IDLE';
        return await ctx.reply(`✅ Đã lưu ${fileType} đính kèm vào mục: [${category}]\nNội dung: ${content}`);
    } 
    else if (appMatch) {
        const content = appMatch[1] ? appMatch[1].trim() : '';
        const newNote = new Note({ content, category: 'App', fileId, fileType });
        await newNote.save();
        ctx.session.state = 'IDLE';
        return await ctx.reply(`✅ Đã lưu ${fileType} đính kèm vào mục: [App]\nNội dung: ${content}`);
    } 
    else if (prMatch) {
        const content = prMatch[1] ? prMatch[1].trim() : '';
        const newNote = new Note({ content, category: 'Prompt', fileId, fileType });
        await newNote.save();
        ctx.session.state = 'IDLE';
        return await ctx.reply(`✅ Đã lưu ${fileType} đính kèm vào mục: [Prompt]\nNội dung: ${content}`);
    }
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).send('OK');
        } else {
            res.status(200).send('Garlic Bot is running!');
        }
    } catch (e) {
        console.error('Lỗi Webhook:', e);
        res.status(500).send('Error');
    }
};
