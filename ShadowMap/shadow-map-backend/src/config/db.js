const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    console.log("开始连接MongoDB...");
    
    await mongoose.connect(
      "mongodb+srv://wujlin5_db_user:wjl12345mongodb@cluster0.1qxqrnr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0",
      {
        serverSelectionTimeoutMS: 5000, // 5秒快速超时
        socketTimeoutMS: 10000,
        maxPoolSize: 5,
        directConnection: false,
        ssl: true,
      }
    );
    console.log("MONGODB CONNECTED SUCCESSFULLY!");
    
    // 测试ping
    const db = mongoose.connection.db;
    const pingResult = await db.admin().ping();
    console.log("Ping结果:", pingResult);
    
  } catch (error) {
    console.error("Error connecting to MONGODB", error);
  }
};

// 执行连接测试
connectDB().then(() => {
  console.log("Test completed");
  process.exit(0);
}).catch(error => {
  console.error("Test failed:", error);
  process.exit(1);
});
