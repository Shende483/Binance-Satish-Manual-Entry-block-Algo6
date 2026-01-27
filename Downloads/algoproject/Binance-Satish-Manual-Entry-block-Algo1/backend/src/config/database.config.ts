import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule, ConfigService } from '@nestjs/config';


export const DatabaseConfig = MongooseModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: async (configService: ConfigService) => {
    try {
      const uri = configService.get<string>('MONGO_URI');
      if (!uri) {
        throw new Error('❌ MONGO_URI is not defined in environment variables');
      }

      console.log('✅ Successfully connected to MongoDB Atlas');
      return { uri };
    } catch (error) {
      console.error('❌ Failed to connect to MongoDB Atlas:', error.message);
      throw error;
    }
  },
});
